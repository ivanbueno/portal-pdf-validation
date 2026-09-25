import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import httpx
import pytest
from azure.storage.blob import generate_blob_sas, BlobSasPermissions
from fastapi.testclient import TestClient
from portal.app import create_app
from portal.config import Settings
from portal.storage import Storage, Conflict
from portal.worker import once

pytestmark = pytest.mark.integration


def test_azure_end_to_end():
    if os.getenv("RUN_AZURE_INTEGRATION") != "1":
        pytest.skip("Start Azurite and set RUN_AZURE_INTEGRATION=1")
    settings = Settings()
    suffix = uuid.uuid4().hex[:12]
    settings.table = "test" + suffix
    settings.container = "test" + suffix
    settings.queue = "test" + suffix
    store = Storage(settings)
    store.initialize()
    client = TestClient(create_app(settings, store))
    try:
        path = Path("tests/fixtures/ua-pass.pdf")
        data = path.read_bytes()
        doc = client.post("/api/v1/documents", json={"name": path.name, "size": len(data)}).json()
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
        saved = store.get("local-development", doc["id"])
        stale = dict(saved)
        store.save(saved)
        with pytest.raises(Conflict):
            store.save(stale)
        blob = store.blob(f"local-development/{doc['id']}/input.pdf")
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
    finally:
        store.container.delete_container()
        store.queue.delete_queue()
        store.tables.delete_table(settings.table)
