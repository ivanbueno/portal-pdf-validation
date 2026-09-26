import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import httpx
import pytest
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from fastapi.testclient import TestClient
from portal.app import create_app
from portal.auth import LOCAL_OWNER
from portal.config import Settings
from portal.domain import LISTED, live_documents
from portal.maintenance import CANDIDATES
from portal.storage import Storage, Conflict
from portal.worker import once

pytestmark = pytest.mark.integration


@pytest.fixture
def azure():
    if os.getenv("RUN_AZURE_INTEGRATION") != "1":
        pytest.skip("Start Azurite and set RUN_AZURE_INTEGRATION=1")
    settings = Settings()
    suffix = uuid.uuid4().hex[:12]
    settings.table = "test" + suffix
    settings.container = "test" + suffix
    settings.queue = "test" + suffix
    store = Storage(settings)
    store.initialize()
    try:
        yield settings, store
    finally:
        store.container.delete_container()
        store.queue.delete_queue()
        store.tables.delete_table(settings.table)


def test_azure_end_to_end(azure):
    settings, store = azure
    client = TestClient(create_app(settings, store))
    path = Path("tests/fixtures/ua-pass.pdf")
    data = path.read_bytes()
    body = {"name": path.name, "size": len(data), "profiles": ["pdfua1", "wcag"]}
    doc = client.post("/api/v1/documents", json=body).json()
    response = httpx.put(
        doc["upload_url"], content=data, headers={"x-ms-blob-type": "BlockBlob"}, trust_env=False
    )
    assert response.status_code == 201, response.text
    assert client.post(f"/api/v1/documents/{doc['id']}/submit").status_code == 202
    # Snapshot must remain unchanged even while the short-lived upload grant is valid.
    assert (
        httpx.put(
            doc["upload_url"],
            content=b"not a PDF",
            headers={"x-ms-blob-type": "BlockBlob"},
            trust_env=False,
        ).status_code
        == 201
    )
    assert once(store, settings)
    result = client.get(f"/api/v1/documents/{doc['id']}").json()
    assert result["status"] == "passed", result
    assert len(result["results"]) == 2
    assert result["page_count"] == 1
    pdf = client.get(f"/api/v1/documents/{doc['id']}/pdf")
    assert pdf.content == data
    assert pdf.headers["content-disposition"].startswith("inline;")
    raw = client.get(f"/api/v1/documents/{doc['id']}/reports/xml?profile=pdfua-1")
    assert raw.status_code == 200 and b'isCompliant="true"' in raw.content
    saved = store.get(LOCAL_OWNER, doc["id"])
    stale = dict(saved)
    store.save(saved)
    with pytest.raises(Conflict):
        store.save(stale)
    blob = store.blob(f"{LOCAL_OWNER}/{doc['id']}/input.pdf")
    expired = generate_blob_sas(
        account_name=store.blobs.account_name,
        container_name=settings.container,
        blob_name=blob.blob_name,
        account_key=store.blobs.credential.account_key,
        permission=BlobSasPermissions(write=True),
        expiry=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    assert (
        httpx.put(
            blob.url + "?" + expired,
            content=data,
            headers={"x-ms-blob-type": "BlockBlob"},
            trust_env=False,
        ).status_code
        == 403
    )
    assert client.delete(f"/api/v1/documents/{doc['id']}").status_code == 204
    assert client.get(f"/api/v1/documents/{doc['id']}/reports/json").status_code == 404


def test_service_prefilters_match_python_checks(azure):
    """The OData prefilters must return exactly the rows the Python checks act on."""
    settings, store = azure
    now = time.time()
    states = {
        "uploading": ("uploading", now + 60),
        "passed": ("passed", now + 60),
        "queued": ("queued", now + 60),
        "running": ("running", now + 60),
        "expired": ("failed", now - 60),
        "deleted": ("deleted", now + 60),
    }
    for owner in ("owner-a", "owner-b"):
        for key, (status, expires) in states.items():
            store.insert(
                dict(
                    PartitionKey=owner,
                    RowKey=key,
                    id=key,
                    kind="document",
                    name=key + ".pdf",
                    status=status,
                    created=now,
                    expires=expires,
                    attempts=0,
                    fingerprint="not listed",
                )
            )
    store.insert(dict(PartitionKey="owner-a", RowKey="other", kind="other", status="queued", expires=now))

    listed = live_documents(store, "owner-a", now)
    assert {row["id"] for row in listed} == {"uploading", "passed", "queued", "running"}
    # Partial rows: only listed, non-null properties, and no ETag so they cannot be saved.
    assert all(set(row) <= set(LISTED) and "_etag" not in row for row in listed)

    candidates = list(store.rows(where=CANDIDATES, parameters={"now": now}))
    assert {(row["PartitionKey"], row["id"]) for row in candidates} == {
        (owner, key)
        for owner in ("owner-a", "owner-b")
        for key in ("queued", "running", "expired", "deleted")
    }
    assert all("_etag" in row for row in candidates)
