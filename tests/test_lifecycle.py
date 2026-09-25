import time
import pytest
from azure.core.exceptions import ServiceRequestError
from portal.auth import owner
from portal.config import MAX_FILE
from portal.domain import tombstone
from portal.maintenance import sweep
from portal.services.runner import ValidationError
from portal.worker import process_document
from conftest import successful_runner

BASE = "/api/v1"


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
    b = client.post(BASE + "/documents", json={"name": "a.pdf", "size": 9}).json()
    assert client.post(f"{BASE}/documents/{b['id']}/submit").status_code == 409
    d = b
    assert client.post(f"{BASE}/documents/{d['id']}/upload-url").status_code == 200
    store.put(f"local-development/{d['id']}/input.pdf", b"%PDF-1.7\n")
    assert client.post(f"{BASE}/documents/{b['id']}/submit").status_code == 202


@pytest.mark.parametrize("contents", [b"not-a-pdf", b"%PDF-too-many-bytes"])
def test_invalid_upload(client, store, uploaded, contents):
    store.put(f"local-development/{uploaded['id']}/input.pdf", contents)
    assert client.post(f"{BASE}/documents/{uploaded['id']}/submit").status_code == 409


def test_full_lifecycle_and_snapshot(client, store, settings, uploaded):
    bid = uploaded["id"]
    did = uploaded["id"]
    assert client.post(f"{BASE}/documents/{bid}/submit").status_code == 202
    assert client.post(f"{BASE}/documents/{bid}/submit").status_code == 202
    assert len(store.messages) == 1
    store.get("local-development", did)
    batch = store.get("local-development", bid)
    assert batch["expires"] - batch["submitted"] == 72 * 3600
    store.put(f"local-development/{did}/input.pdf", b"overwritten")

    def runner(path, profile, s):
        assert path.read_bytes() == b"%PDF-1.7\n"
        return successful_runner(path, profile, s)

    assert process_document(store, settings, "local-development", did, runner)
    assert process_document(store, settings, "local-development", did, runner)
    response = client.get(f"{BASE}/documents/{did}").json()
    assert response["status"] == "passed" and response["passed"]
    assert len(response["results"]) == 2
    assert client.get(f"{BASE}/documents/{did}/reports/json").json()["passed"]
    assert client.get(f"{BASE}/documents/{did}/reports/xml?profile=pdfua-1").status_code == 200
    assert client.post(f"{BASE}/documents/{did}/upload-url").status_code == 409
    assert store.get("local-development", did)["attempts"] == 1


def test_partial_profile_results(client, store, settings, uploaded):
    client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    did = uploaded["id"]

    def runner(path, profile, s):
        if profile == "wcag-2.2":
            raise ValidationError("Validation timed out")
        return successful_runner(path, profile, s)

    process_document(store, settings, "local-development", did, runner)
    result = client.get(f"{BASE}/documents/{did}").json()
    assert result["status"] == "error"
    assert result["results"][0]["passed"] is True
    assert result["results"][1]["passed"] is None
    assert client.get(f"{BASE}/documents/{did}/reports/xml?profile=wcag-2.2").status_code == 404


def test_outbox_recovers_queue_failure(client, store, settings, uploaded, monkeypatch):
    real = store.enqueue
    monkeypatch.setattr(store, "enqueue", lambda *args: (_ for _ in ()).throw(ServiceRequestError("offline")))
    assert client.post(f"{BASE}/documents/{uploaded['id']}/submit").status_code == 503
    assert store.get("local-development", uploaded["id"])["status"] == "queued"
    monkeypatch.setattr(store, "enqueue", real)
    sweep(store, settings)
    assert len(store.messages) == 1


def test_worker_lease_and_crash_recovery(client, store, settings, uploaded):
    client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    did = uploaded["id"]
    doc = store.get("local-development", did)
    doc.update(status="running", attempts=1, lease_until=time.time() + 60, run_id="crashed")
    store.save(doc)
    assert not process_document(store, settings, "local-development", did, successful_runner)
    doc = store.get("local-development", did)
    doc["lease_until"] = time.time() - 1
    store.save(doc)
    sweep(store, settings)
    assert process_document(store, settings, "local-development", did, successful_runner)
    assert store.get("local-development", did)["attempts"] == 2


def test_delete_race_does_not_publish(client, store, settings, uploaded):
    client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    did = uploaded["id"]

    def runner(path, profile, s):
        if profile == "wcag-2.2":
            assert client.delete(f"{BASE}/documents/{did}").status_code == 204
        return successful_runner(path, profile, s)

    process_document(store, settings, "local-development", did, runner)
    assert client.get(f"{BASE}/documents/{did}").status_code == 404
    assert store.get("local-development", did)["status"] == "deleted"
    sweep(store, settings)
    assert not store.objects


def test_owner_isolation(client, uploaded):
    client.app.dependency_overrides[owner] = lambda: "other-user"
    assert client.get(f"{BASE}/documents/{uploaded['id']}").status_code == 404
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
    batch = store.get("local-development", uploaded["id"])
    batch["expires"] = time.time() - 1
    store.save(batch)
    assert client.get(f"{BASE}/documents/{uploaded['id']}").status_code == 404
    sweep(store, settings)
    assert not store.objects
    did = uploaded["id"]
    store.put(f"local-development/{did}/input.pdf", b"late SAS write")
    for row in store.rows():
        row["purge_after"] = time.time() - 1
        store.save(row)
    sweep(store, settings)
    assert not store.objects and not store.rows()


def test_document_tombstone_revokes_access_before_sweep(client, store, settings, uploaded):
    tombstone(store, store.get("local-development", uploaded["id"]), settings)
    assert client.get(f"{BASE}/documents/{uploaded['id']}").status_code == 404
    sweep(store, settings)
    assert not store.objects


def test_three_transient_attempts(client, store, settings, uploaded, monkeypatch):
    client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    did = uploaded["id"]
    monkeypatch.setattr(
        store, "download", lambda *args: (_ for _ in ()).throw(ServiceRequestError("offline"))
    )
    for i in range(3):
        process_document(store, settings, "local-development", did, successful_runner)
    doc = store.get("local-development", did)
    assert doc["status"] == "error" and doc["attempts"] == 3


def test_issue_pagination(client, store, settings, uploaded):
    client.post(f"{BASE}/documents/{uploaded['id']}/submit")
    did = uploaded["id"]

    def runner(path, profile, s):
        r, raw = successful_runner(path, profile, s)
        r.update(issues=[{"message": str(i)} for i in range(201)], passed=False, status="failed")
        return r, raw

    process_document(store, settings, "local-development", did, runner)
    response = client.get(f"{BASE}/documents/{did}?offset=100&limit=100").json()
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
    monkeypatch.setattr(
        store, "upload_url", lambda *args: (_ for _ in ()).throw(ServiceRequestError("offline"))
    )
    body = {"name": "a.pdf", "size": 9}
    failed = client.post(BASE + "/documents", json=body)
    assert failed.status_code == 503
    key = failed.headers["Idempotency-Key"]
    monkeypatch.setattr(store, "upload_url", real)
    replay = client.post(BASE + "/documents", json=body, headers={"Idempotency-Key": key})
    assert replay.status_code == 201 and len(store.rows()) == 1


def test_independent_submissions_and_history_pagination(client, store, settings, uploaded):
    other = client.post(BASE + "/documents", json={"name": "missing.pdf", "size": 9}).json()
    assert client.post(f"{BASE}/documents/{other['id']}/submit").status_code == 409
    assert client.post(f"{BASE}/documents/{uploaded['id']}/submit").status_code == 202
    assert process_document(store, settings, "local-development", uploaded["id"], successful_runner)
    page = client.get(BASE + "/documents?limit=1").json()
    assert page["total"] == 2 and len(page["items"]) == 1
    second = client.get(BASE + "/documents?limit=1&offset=1").json()
    assert second["items"][0]["id"] != page["items"][0]["id"]
    client.delete(f"{BASE}/documents/{other['id']}")
    assert client.get(f"{BASE}/documents/{uploaded['id']}").json()["status"] == "passed"


def test_preview_migration_preserves_records_and_revocation(store, settings):
    from portal.migrate import migrate

    for status in ("submitted", "deleted"):
        parent = store.insert(
            dict(
                PartitionKey="owner",
                RowKey=status,
                id=status,
                kind="batch",
                status=status,
                submitted=time.time(),
                expires=time.time() + 9000,
            )
        )
        store.insert(
            dict(
                PartitionKey="owner",
                RowKey=status + "-000",
                id=status + "-000",
                kind="document",
                batch_id=status,
                status="uploading",
                snapshot="immutable",
                expires=1,
                name="a.pdf",
                size=9,
                attempts=0,
            )
        )
        assert parent
    migrate(store, settings)
    migrate(store, settings)
    queued = store.get("owner", "submitted-000")
    deleted = store.get("owner", "deleted-000")
    assert queued["status"] == "queued" and queued["snapshot"] == "immutable"
    assert queued["expires"] > time.time() and "batch_id" not in queued
    assert deleted["status"] == "deleted" and deleted["purge_after"] > time.time()
    assert len(store.rows()) == 2


@pytest.mark.parametrize("key", ["", "has spaces", "x" * 129, "unsafe\r\nheader"])
def test_invalid_idempotency_keys(client, key):
    assert (
        client.post(
            BASE + "/documents", json={"name": "a.pdf", "size": 9}, headers={"Idempotency-Key": key}
        ).status_code
        == 422
    )


def test_replay_after_submission_does_not_reopen_upload(client, uploaded):
    doc_id = uploaded["id"]
    assert client.post(f"{BASE}/documents/{doc_id}/submit").status_code == 202
    replay = client.post(
        BASE + "/documents",
        json={"name": "example.pdf", "size": 9},
        headers={"Idempotency-Key": uploaded["idempotency_key"]},
    )
    assert replay.status_code == 201 and replay.json()["id"] == doc_id
    assert replay.json()["status"] == "queued" and "upload_url" not in replay.json()
    client.delete(f"{BASE}/documents/{doc_id}")
    assert (
        client.post(
            BASE + "/documents",
            json={"name": "example.pdf", "size": 9},
            headers={"Idempotency-Key": uploaded["idempotency_key"]},
        ).status_code
        == 409
    )
