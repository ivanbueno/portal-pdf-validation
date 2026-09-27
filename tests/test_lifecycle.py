import json
import sys
import time
import pytest
from azure.core.exceptions import ServiceRequestError
from fastapi.testclient import TestClient
from portal import app as portal_app, cli, worker
from portal.auth import owner
from portal.config import MAX_FILE, MAX_FILES
from portal.domain import tombstone
from portal.maintenance import sweep
from portal.services.runner import ValidationError
from portal.storage import Conflict
from portal.worker import process_document, summarize
from conftest import ISSUE, OWNER, UPLOAD, failing_runner, put_input, raising, successful_runner

BASE = "/api/v1"


def test_profiles_default_to_wcag_and_accept_aliases(client):
    def profiles(body):
        return client.post(BASE + "/documents", json={"name": "a.pdf"} | body)

    assert profiles({}).json()["validation_profiles"] == ["wcag"]
    # The portal preselects exactly the profiles the API runs by default.
    options = client.get("/api/config").json()["profiles"]
    assert [option["alias"] for option in options if option["default"]] == ["wcag"]
    assert profiles({"profiles": ["pdfua1"]}).json()["validation_profiles"] == ["pdfua1"]
    both = profiles({"profiles": ["wcag-2.2", "pdfua1"]}).json()
    assert both["validation_profiles"] == ["wcag", "pdfua1"]
    for invalid in (["wcag", "wcag-2.2"], ["pdfua2"], []):
        assert profiles({"profiles": invalid}).status_code == 422


def test_generated_keys_and_duplicate_names(client):
    body = {"name": "same.pdf", "size": 9}
    a = client.post(BASE + "/documents", json=body)
    b = client.post(BASE + "/documents", json=body)
    assert a.status_code == b.status_code == 201
    assert a.json()["id"] != b.json()["id"]
    key = a.json()["idempotency_key"]
    assert a.headers["Idempotency-Key"] == key
    assert a.headers["Location"] == BASE + "/documents/" + a.json()["id"]
    replay = client.post(BASE + "/documents", json=body, headers={"Idempotency-Key": key})
    assert replay.json()["id"] == a.json()["id"]
    assert (
        client.post(
            BASE + "/documents", json=body | {"size": 10}, headers={"Idempotency-Key": key}
        ).status_code
        == 409
    )
    assert len(client.get(BASE + "/documents").json()["items"]) == 2


def test_explicit_key_and_retired_batch_contract(client):
    body = {"name": "same.pdf", "size": 9}
    headers = {"Idempotency-Key": "integration-key"}
    a = client.post(BASE + "/documents", json=body, headers=headers)
    b = client.post(BASE + "/documents", json=body, headers=headers)
    assert a.json()["id"] == b.json()["id"]
    assert client.post(BASE + "/batches", json={"files": [body]}).status_code == 404
    assert client.post(BASE + "/documents", json={"files": [body]}).status_code == 422
    assert not any("batches" in p for p in client.get("/openapi.json").json()["paths"])


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"name": "a.txt", "size": 9},
        {"name": "../x.pdf", "size": 9},
        {"name": "x.pdf", "size": 0},
        {"name": "x.pdf", "size": MAX_FILE + 1},
        {"name": "x.pdf", "size": True},
        {"name": "x.pdf", "size": "9"},
    ],
)
def test_upload_limits(client, body):
    assert client.post(BASE + "/documents", json=body).status_code == 422


def test_boundary_limits(client):
    assert client.post(BASE + "/documents", json={"name": "x.pdf", "size": MAX_FILE}).status_code == 201


def test_incomplete_upload_can_resume(client, store):
    doc = client.post(BASE + "/documents", json={"name": "a.pdf", "size": 9}).json()
    # Nothing is published before validation finishes.
    assert client.get(f"{BASE}/documents/{doc['id']}").json()["results"] == []
    assert client.post(f"{BASE}/documents/{doc['id']}/submit").status_code == 409
    assert client.post(f"{BASE}/documents/{doc['id']}/upload-url").status_code == 200
    put_input(store, doc["id"])
    assert client.post(f"{BASE}/documents/{doc['id']}/submit").status_code == 202


@pytest.mark.parametrize(
    "contents, detail",
    [
        (b"not-a-pdf", "File is not a PDF"),
        (b"%PDF-too-many-bytes", "Uploaded size does not match the reserved file size"),
    ],
)
def test_invalid_upload(client, store, uploaded, contents, detail):
    put_input(store, uploaded["id"], contents)
    response = client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    # The caller learns what is wrong with the file, not just that submission failed.
    assert response.status_code == 409 and response.json()["detail"] == detail


def test_full_lifecycle_and_snapshot(client, store, settings, submitted):
    did = submitted
    assert client.post(f"{BASE}/documents/{did}/submit").status_code == 202
    assert len(store.messages) == 1
    doc = store.get(OWNER, did)
    assert doc["expires"] - doc["submitted"] == 72 * 3600
    put_input(store, did, b"overwritten")

    def runner(path, profile, s):
        assert path.read_bytes() == b"%PDF-1.7\n"
        return successful_runner(path, profile, s)

    assert process_document(store, settings, OWNER, did, runner)
    assert process_document(store, settings, OWNER, did, runner)
    response = client.get(f"{BASE}/documents/{did}").json()
    assert response["status"] == "passed" and response["passed"]
    assert len(response["results"]) == 2
    assert client.get(f"{BASE}/documents/{did}/reports/json").json()["passed"]
    assert client.get(f"{BASE}/documents/{did}/reports/xml?profile=pdfua-1").status_code == 200
    assert client.post(f"{BASE}/documents/{did}/upload-url").status_code == 409
    assert store.get(OWNER, did)["attempts"] == 1


def test_partial_profile_results(client, store, settings, submitted):

    def runner(path, profile, s):
        if profile == "wcag-2.2":
            raise ValidationError("Validation timed out")
        return successful_runner(path, profile, s)

    process_document(store, settings, OWNER, submitted, runner)
    result = client.get(f"{BASE}/documents/{submitted}").json()
    assert result["status"] == "error"
    assert result["results"][0]["passed"] is True
    assert result["results"][1]["passed"] is None
    assert client.get(f"{BASE}/documents/{submitted}/reports/xml?profile=wcag-2.2").status_code == 404


def test_report_parameters_are_validated_and_documented(client, store, settings, submitted):
    reports = f"{BASE}/documents/{submitted}/reports"
    assert client.get(reports + "/json").status_code == 409
    process_document(store, settings, OWNER, submitted, successful_runner)
    assert client.get(reports + "/json?profile=pdfua-1").status_code == 200
    # XML takes a profile ID, not its alias.
    for invalid in ("/pdf", "/xml", "/xml?profile=pdfua1", "/xml?profile=pdfua-2"):
        assert client.get(reports + invalid).status_code == 422, invalid
    paths = client.get("/openapi.json").json()["paths"]
    parameters = {
        p["name"]: p["schema"]
        for p in paths[BASE + "/documents/{doc_id}/reports/{format}"]["get"]["parameters"]
    }
    assert parameters["format"]["enum"] == ["json", "xml"]
    assert parameters["profile"]["anyOf"][0]["enum"] == ["wcag-2.2", "pdfua-1"]
    issues = paths[BASE + "/documents/{doc_id}/issues"]["get"]["responses"]["200"]
    assert issues["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/IssuePage"}


def test_outbox_recovers_queue_failure(client, store, settings, uploaded, monkeypatch):
    real = store.enqueue
    monkeypatch.setattr(store, "enqueue", raising(ServiceRequestError("offline")))
    assert client.post(f"{BASE}/documents/{uploaded['id']}/submit").status_code == 503
    assert store.get(OWNER, uploaded["id"])["status"] == "queued"
    monkeypatch.setattr(store, "enqueue", real)
    sweep(store, settings)
    assert len(store.messages) == 1


def test_worker_lease_and_crash_recovery(store, settings, submitted):
    doc = store.get(OWNER, submitted)
    doc.update(status="running", attempts=1, lease_until=time.time() + 60, run_id="crashed")
    store.save(doc)
    assert not process_document(store, settings, OWNER, submitted, successful_runner)
    doc = store.get(OWNER, submitted)
    doc["lease_until"] = time.time() - 1
    store.save(doc)
    sweep(store, settings)
    assert process_document(store, settings, OWNER, submitted, successful_runner)
    assert store.get(OWNER, submitted)["attempts"] == 2


def test_delete_race_does_not_publish(client, store, settings, submitted, monkeypatch):
    events = []
    monkeypatch.setattr(worker, "log_event", lambda logger, event, *args, **fields: events.append(event))

    def runner(path, profile, s):
        if profile == "wcag-2.2":
            assert client.delete(f"{BASE}/documents/{submitted}").status_code == 204
        return successful_runner(path, profile, s)

    process_document(store, settings, OWNER, submitted, runner)
    # The final save lost to the deletion, so the attempt never reports finishing.
    assert events == ["validation_started"]
    assert client.get(f"{BASE}/documents/{submitted}").status_code == 404
    assert store.get(OWNER, submitted)["status"] == "deleted"
    sweep(store, settings)
    assert not store.objects


def test_publish_needs_no_ownership_read(store, settings, submitted, monkeypatch):
    real, reads = store.get, []
    monkeypatch.setattr(store, "get", lambda *key: reads.append(key) or real(*key))
    assert process_document(store, settings, OWNER, submitted, successful_runner)
    # The initial read and one ownership check per profile; the ETag-fenced save needs none.
    assert len(reads) == 1 + len(UPLOAD["profiles"])
    assert real(OWNER, submitted)["status"] == "passed"


def test_owner_isolation(client, uploaded):
    client.app.dependency_overrides[owner] = lambda: "other-user"
    did = uploaded["id"]
    for method, path in [
        ("get", f"/documents/{did}"),
        ("delete", f"/documents/{did}"),
        ("post", f"/documents/{did}/upload-url"),
        ("get", f"/documents/{did}/reports/json"),
    ]:
        assert getattr(client, method)(BASE + path).status_code == 404
    assert client.get(BASE + "/documents").json()["items"] == []


def test_expiration_and_late_upload_cleanup(client, store, settings, uploaded):
    doc = store.get(OWNER, uploaded["id"])
    doc["expires"] = time.time() - 1
    store.save(doc)
    assert client.get(f"{BASE}/documents/{uploaded['id']}").status_code == 404
    sweep(store, settings)
    assert not store.objects
    put_input(store, uploaded["id"], b"late SAS write")
    for row in store.rows():
        row["purge_after"] = time.time() - 1
        store.save(row)
    sweep(store, settings)
    assert not store.objects and not store.rows()


def test_document_tombstone_revokes_access_before_sweep(client, store, settings, uploaded):
    tombstone(store, settings, store.get(OWNER, uploaded["id"]))
    assert client.get(f"{BASE}/documents/{uploaded['id']}").status_code == 404
    sweep(store, settings)
    assert not store.objects


def test_delete_all_documents_is_scoped_to_the_owner(client, store, settings, submitted):
    client.post(BASE + "/documents", json={"name": "still-uploading.pdf", "size": 9})
    client.app.dependency_overrides[owner] = lambda: "other-user"
    other = client.post(BASE + "/documents", json={"name": "other.pdf", "size": 9}).json()
    client.app.dependency_overrides.clear()
    assert client.delete(BASE + "/documents").json() == {"deleted": 2}
    assert client.get(BASE + "/documents").json()["total"] == 0
    assert client.delete(BASE + "/documents").json() == {"deleted": 0}
    # The worker drops the queued document's message; maintenance purges its files.
    assert process_document(store, settings, OWNER, submitted, successful_runner)
    assert store.get(OWNER, submitted)["status"] == "deleted"
    sweep(store, settings)
    assert not store.objects
    client.app.dependency_overrides[owner] = lambda: "other-user"
    assert client.get(f"{BASE}/documents/{other['id']}").status_code == 200


def test_delete_all_retries_a_row_changed_meanwhile(client, store, submitted, monkeypatch):
    real_rows = store.rows

    def rows(*args, **kwargs):
        listed = real_rows(*args, **kwargs)
        store.save(store.get(OWNER, submitted))  # A worker saved it after it was listed.
        return listed

    monkeypatch.setattr(store, "rows", rows)
    assert client.delete(BASE + "/documents").json() == {"deleted": 1}
    assert store.get(OWNER, submitted)["status"] == "deleted"
    monkeypatch.setattr(store, "rows", real_rows)
    client.post(BASE + "/documents", json={"name": "b.pdf", "size": 9})
    monkeypatch.setattr(store, "save", raising(Conflict()))
    assert client.delete(BASE + "/documents").status_code == 409


def test_three_transient_attempts(store, settings, submitted, monkeypatch):
    monkeypatch.setattr(store, "download", raising(ServiceRequestError("offline")))
    for _ in range(3):
        process_document(store, settings, OWNER, submitted, successful_runner)
    doc = store.get(OWNER, submitted)
    assert doc["status"] == "error" and doc["attempts"] == 3


def test_exhausted_document_changed_meanwhile_is_left_alone(store, settings, submitted, monkeypatch):
    doc = store.get(OWNER, submitted)
    store.save(doc | {"attempts": 3})
    monkeypatch.setattr(store, "save", raising(Conflict()))
    # A concurrent change (say, a deletion) wins; the message is still acknowledged.
    assert process_document(store, settings, OWNER, submitted, successful_runner)


def test_failed_publish_requeues_without_partial_report(store, settings, submitted, monkeypatch):
    real = store.save

    def save(entity):
        if "report" in entity:
            raise ServiceRequestError("offline")
        return real(entity)

    monkeypatch.setattr(store, "save", save)
    assert not process_document(store, settings, OWNER, submitted, successful_runner)
    doc = store.get(OWNER, submitted)
    assert doc["status"] == "queued" and doc["error"] == "Temporary processing failure"
    assert "report" not in doc and "profile_summaries" not in doc


@pytest.mark.parametrize(
    "statuses, overall",
    [(("passed", "passed"), "passed"), (("passed", "failed"), "failed"), (("failed", "error"), "error")],
)
def test_summarize_overall_status_and_fields(statuses, overall):
    results = [
        {
            "profile": profile,
            "status": status,
            "passed": status == "passed",
            "issues": [ISSUE],
            "page_count": pages,
        }
        for profile, status, pages in zip(("pdfua-1", "wcag-2.2"), statuses, (None, 4))
    ]
    report, fields = summarize("doc", results)
    assert fields["status"] == overall and report["passed"] == fields["passed"] == (overall == "passed")
    assert report["page_count"] == fields["page_count"] == 4 and report["results"] is results
    assert [group["counts"] for group in report["issue_groups"]] == [{"pdfua-1": 1, "wcag-2.2": 1}]
    summaries = json.loads(fields["profile_summaries"])
    assert [set(summary) for summary in summaries] == [{"profile", "status", "passed"}] * 2


def test_issue_pagination(client, store, settings, submitted):
    runner = failing_runner([{"message": str(i)} for i in range(201)])
    process_document(store, settings, OWNER, submitted, runner)
    response = client.get(f"{BASE}/documents/{submitted}?offset=100&limit=100").json()
    assert len(response["results"][0]["issues"]) == 100
    assert response["results"][0]["issues"][0]["message"] == "100"
    assert response["results"][0]["issue_total"] == 201


def test_metadata_request_body_limit(client):
    assert (
        client.post(
            BASE + "/documents", content=b"x" * (256 * 1024 + 1), headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )


def test_generated_key_survives_grant_failure(client, store, monkeypatch):
    real = store.upload_url
    monkeypatch.setattr(store, "upload_url", raising(ServiceRequestError("offline")))
    body = {"name": "a.pdf", "size": 9}
    failed = client.post(BASE + "/documents", json=body)
    assert failed.status_code == 503
    key = failed.headers["Idempotency-Key"]
    monkeypatch.setattr(store, "upload_url", real)
    replay = client.post(BASE + "/documents", json=body, headers={"Idempotency-Key": key})
    assert replay.status_code == 201 and len(store.rows()) == 1


def test_unexpected_failure_keeps_request_id_and_idempotency_key(settings, store, monkeypatch):
    events = []
    monkeypatch.setattr(portal_app, "log_event", lambda logger, event, *args, **fields: events.append(fields))
    monkeypatch.setattr(store, "upload_url", raising(RuntimeError("private/path.pdf")))
    client = TestClient(portal_app.create_app(settings, store), raise_server_exceptions=False)
    failed = client.post(BASE + "/documents", json={"name": "a.pdf", "size": 9})
    assert failed.status_code == 500 and failed.json() == {"detail": "Internal server error"}
    assert failed.headers["Cache-Control"] == "no-store" and failed.headers["Idempotency-Key"]
    # The request is logged with its ID and the exception type, never the message.
    assert events == [
        {
            "request_id": failed.headers["X-Request-ID"],
            "status": 500,
            "duration_ms": events[0]["duration_ms"],
            "error": "RuntimeError",
        }
    ]


def test_independent_submissions_and_history_pagination(client, store, settings, uploaded):
    other = client.post(BASE + "/documents", json={"name": "missing.pdf", "size": 9}).json()
    assert client.post(f"{BASE}/documents/{other['id']}/submit").status_code == 409
    assert client.post(f"{BASE}/documents/{uploaded['id']}/submit").status_code == 202
    assert process_document(store, settings, OWNER, uploaded["id"], successful_runner)
    page = client.get(BASE + "/documents?limit=1").json()
    assert page["total"] == 2 and len(page["items"]) == 1
    second = client.get(BASE + "/documents?limit=1&offset=1").json()
    assert second["items"][0]["id"] != page["items"][0]["id"]
    # A page can hold a whole portal selection, and no more.
    assert client.get(f"{BASE}/documents?limit={MAX_FILES}").status_code == 200
    assert client.get(f"{BASE}/documents?limit={MAX_FILES + 1}").status_code == 422
    client.delete(f"{BASE}/documents/{other['id']}")
    assert client.get(f"{BASE}/documents/{uploaded['id']}").json()["status"] == "passed"


@pytest.mark.parametrize("key", ["", "has spaces", "x" * 129, "unsafe\r\nheader"])
def test_invalid_idempotency_keys(client, key):
    assert (
        client.post(
            BASE + "/documents", json={"name": "a.pdf", "size": 9}, headers={"Idempotency-Key": key}
        ).status_code
        == 422
    )


def test_replay_after_submission_does_not_reopen_upload(client, uploaded, submitted):
    replay = client.post(
        BASE + "/documents", json=UPLOAD, headers={"Idempotency-Key": uploaded["idempotency_key"]}
    )
    assert replay.status_code == 201 and replay.json()["id"] == submitted
    assert replay.json()["status"] == "queued" and "upload_url" not in replay.json()
    client.delete(f"{BASE}/documents/{submitted}")
    assert (
        client.post(
            BASE + "/documents", json=UPLOAD, headers={"Idempotency-Key": uploaded["idempotency_key"]}
        ).status_code
        == 409
    )


@pytest.fixture
def entry_point(monkeypatch, settings, store):
    """Runs `cli.run` against the test store with the given command-line flags."""
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    monkeypatch.setattr(cli, "Storage", lambda s: store)

    def run(step, *flags):
        monkeypatch.setattr(sys, "argv", ["pdf-test", *flags])
        cli.run(step, interval=0)

    return run


def test_loop_logs_failed_steps_and_continues(entry_point, monkeypatch):
    calls, events = [], []

    def step(store, settings):
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("private/path.pdf")

    class Stop(BaseException):
        pass

    def sleep(seconds):
        if len(calls) == 2:
            raise Stop()

    monkeypatch.setattr(cli.time, "sleep", sleep)
    monkeypatch.setattr(
        cli, "log_event", lambda logger, event, level, **fields: events.append((event, fields))
    )
    with pytest.raises(Stop):
        entry_point(step, "--loop")
    assert calls == [0, 1]
    # The exception type only: messages may carry paths or tokens.
    assert events == [("step_failed", {"step": "step", "type": "RuntimeError"})]


def test_single_run_propagates_failures(entry_point):
    def step(store, settings):
        raise RuntimeError("Maintenance incomplete")

    with pytest.raises(RuntimeError):
        entry_point(step)
