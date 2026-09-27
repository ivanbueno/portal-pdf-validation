import base64
import json
import time
import pytest
from portal.auth import owner
from portal.services.documents import ACTIVITY_FIELDS
from portal.worker import process_document
from conftest import ISSUE, OWNER, failing_runner, successful_runner

BASE = "/api/v1/documents"


def test_summary_contract_and_metadata_only_status(client, store, settings, submitted, monkeypatch):
    process_document(store, settings, OWNER, submitted, failing_runner([ISSUE]))

    def no_blob(*args):
        pytest.fail("Status polling must not read blobs")

    monkeypatch.setattr(store, "read", no_blob)
    status = client.get(f"{BASE}/{submitted}/status").json()
    assert status["status"] == "failed"
    assert status["profiles"][0]["summary"]["errors"] == 1
    assert "issues" not in status["profiles"][0] and "issue_total" not in status["profiles"][0]
    assert "results" not in status
    client.app.dependency_overrides[owner] = lambda: "someone-else"
    assert client.get(f"{BASE}/{submitted}/status").status_code == 404


def test_activity_projects_only_active_metadata(client, store, settings, submitted, monkeypatch):
    real, queries = store.rows, []

    def rows(*args, **kwargs):
        queries.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(store, "rows", rows)
    result = client.get(BASE + "/activity").json()["items"]
    assert result[0]["id"] == submitted and set(result[0]) == set(ACTIVITY_FIELDS)
    assert queries[0]["select"] == ACTIVITY_FIELDS
    assert "status eq 'queued'" in queries[0]["where"]
    process_document(store, settings, OWNER, submitted, successful_runner)
    assert client.get(BASE + "/activity").json() == {"items": []}


def test_cursor_does_not_skip_or_repeat_after_inserts_and_deletes(client, store):
    ids = []
    for i in range(6):
        item = client.post(BASE, json={"name": f"{i}.pdf"}).json()
        # Equal timestamps exercise the ID tie-breaker.
        row = store.get(OWNER, item["id"])
        store.save(row | {"created": 100.0})
        ids.append(item["id"])
    expected = sorted(ids, reverse=True)
    first = client.get(BASE, params={"limit": 2}).json()
    assert [item["id"] for item in first["items"]] == expected[:2]
    client.delete(f"{BASE}/{expected[0]}")
    client.post(BASE, json={"name": "new.pdf"})
    collected = [item["id"] for item in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = client.get(BASE, params={"limit": 2, "cursor": cursor}).json()
        collected.extend(item["id"] for item in page["items"])
        cursor = page.get("next_cursor")
    assert collected == expected
    assert client.get(BASE, params={"cursor": first["next_cursor"], "offset": 1}).status_code == 422
    assert client.get(BASE, params={"cursor": first["next_cursor"], "q": "other"}).status_code == 422


@pytest.mark.parametrize(
    "cursor",
    ["garbage", "e30=", base64.urlsafe_b64encode(json.dumps([10**500, "a", "", "all"]).encode()).decode()],
)
def test_invalid_cursors_return_422(client, cursor):
    assert client.get(BASE, params={"cursor": cursor}).status_code == 422


def test_report_pages_only_read_intersecting_chunks(client, store, settings, submitted, monkeypatch):
    issues = [ISSUE | {"message": str(i), "clause": str(i)} for i in range(1201)]
    process_document(store, settings, OWNER, submitted, failing_runner(issues))
    real, reads = store.read, []

    def read(name):
        reads.append(name)
        return real(name)

    monkeypatch.setattr(store, "read", read)
    result = client.get(f"{BASE}/{submitted}?offset=499&limit=3").json()
    assert [i["message"] for i in result["results"][0]["issues"]] == ["499", "500", "501"]
    assert result["results"][0]["issue_total"] == 1201
    assert len(reads) == 5  # Index plus two chunks per profile.
    assert all(not name.endswith("report.json") for name in reads)
    reads.clear()
    groups = client.get(f"{BASE}/{submitted}/issues?offset=99&limit=3").json()
    assert [i["clause"] for i in groups["items"]] == ["99", "100", "101"]
    assert groups["total"] == 1201
    assert [name.rsplit("/", 2)[-2:] for name in reads[1:]] == [["groups", "0.json"], ["groups", "1.json"]]
    reads.clear()
    assert client.get(f"{BASE}/{submitted}/issues?offset=1300").json()["items"] == []
    assert len(reads) == 1  # Only the small index for an out-of-range page.


def test_streamed_exports(client, store, settings, submitted, monkeypatch):
    process_document(store, settings, OWNER, submitted, failing_runner([ISSUE] * 3))
    report = json.loads(store.read(store.get(OWNER, submitted)["report"]))
    monkeypatch.setattr(store, "read", lambda *args: pytest.fail("Download must stream"))
    assert client.get(f"{BASE}/{submitted}/reports/json").json() == report
    assert client.get(f"{BASE}/{submitted}/reports/xml?profile=pdfua-1").status_code == 200
    row = store.get(OWNER, submitted)
    store.save(row | {"expires": time.time() - 1})
    assert client.get(f"{BASE}/{submitted}/reports/json").status_code == 404
