import copy
import time
import uuid
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from azure.core.exceptions import ResourceNotFoundError
from portal.auth import LOCAL_OWNER as OWNER
from portal.config import Settings
from portal.storage import Conflict
from portal.app import create_app


class MemoryStorage:
    def __init__(self):
        self.entities, self.objects, self.messages = {}, {}, []

    def initialize(self):
        pass

    def get(self, owner, key):
        return copy.deepcopy(self.entities.get((owner, key)))

    def insert(self, entity):
        key = (entity["PartitionKey"], entity["RowKey"])
        if key in self.entities:
            raise Conflict()
        self.entities[key] = copy.deepcopy(entity) | {"_etag": uuid.uuid4().hex}
        # Like Table Storage, a write answers with its ETag instead of a re-read.
        return copy.deepcopy(self.entities[key])

    def save(self, entity):
        key = (entity["PartitionKey"], entity["RowKey"])
        if key not in self.entities or self.entities[key]["_etag"] != entity["_etag"]:
            raise Conflict()
        self.entities[key] = copy.deepcopy(entity) | {"_etag": uuid.uuid4().hex}
        return copy.deepcopy(self.entities[key])

    def remove(self, entity):
        key = (entity["PartitionKey"], entity["RowKey"])
        if self.entities[key]["_etag"] != entity["_etag"]:
            raise Conflict()
        del self.entities[key]

    def rows(self, owner=None, where=None, parameters=None, select=None):
        # Ignores the OData prefilter on purpose: callers must be correct without it.
        rows = [copy.deepcopy(v) for (p, k), v in self.entities.items() if not owner or p == owner]
        if select:
            # A partial `$select` read: only listed, non-null properties and no ETag.
            rows = [{k: row[k] for k in select if row.get(k) is not None} for row in rows]
        return rows

    def upload_url(self, name):
        return "https://storage.test/" + name + "?sig=example", time.time() + 3600

    def snapshot(self, name, size):
        if name not in self.objects:
            raise ResourceNotFoundError("missing")
        data = self.objects[name]
        if len(data) != size:
            raise ValueError("Uploaded size does not match the reserved file size")
        if not data.startswith(b"%PDF-"):
            raise ValueError("File is not a PDF")
        snapshot = uuid.uuid4().hex
        self.objects[(name, snapshot)] = data
        return snapshot, len(data)

    def enqueue(self, owner, doc_id):
        self.messages.append({"owner": owner, "document_id": doc_id})

    def put(self, name, data, content_type="application/json"):
        self.objects[name] = data

    def read(self, name):
        return self.objects[name]

    def download(self, name, target, snapshot=None):
        Path(target).write_bytes(self.objects[(name, snapshot)] if snapshot else self.objects[name])

    def stream(self, name, snapshot=None):
        return iter([self.objects[(name, snapshot)] if snapshot else self.objects[name]])

    def purge(self, prefix):
        self.objects = {
            k: v
            for k, v in self.objects.items()
            if not (k[0] if isinstance(k, tuple) else k).startswith(prefix)
        }


@pytest.fixture
def settings():
    return Settings(_env_file=None, environment="test", dev_identity=True)


@pytest.fixture
def store():
    return MemoryStorage()


@pytest.fixture
def client(settings, store):
    return TestClient(create_app(settings, store))


# A failed check as the parser reports it; the same check fails under both profiles.
ISSUE = {
    "rule_id": "ISO 14289-1:2014:7.2:20",
    "specification": "ISO 14289-1:2014",
    "clause": "7.2",
    "test_number": "20",
    "message": "Failed check",
}

# Requests every profile (the API default is WCAG only) so shared tests cover multi-profile results.
UPLOAD = {"name": "example.pdf", "size": 9, "profiles": ["pdfua1", "wcag"]}


def put_input(store, doc_id, data=b"%PDF-1.7\n"):
    """Stands in for the client's upload, which goes straight to Blob Storage."""
    store.put(f"{OWNER}/{doc_id}/input.pdf", data)


def raising(error):
    """A stand-in for a storage call that always fails with `error`."""

    def fail(*args, **kwargs):
        raise error

    return fail


@pytest.fixture
def uploaded(client, store):
    response = client.post("/api/v1/documents", json=UPLOAD)
    assert response.status_code == 201, response.text
    doc = response.json()
    put_input(store, doc["id"])
    return doc


@pytest.fixture
def submitted(client, uploaded):
    """The uploaded document's ID, once submission has queued it for a worker."""
    response = client.post(f"/api/v1/documents/{uploaded['id']}/submit")
    assert response.status_code == 202, response.text
    return uploaded["id"]


def successful_runner(path, profile, settings):
    return {
        "profile": profile,
        "status": "passed",
        "passed": True,
        "summary": {"errors": 0, "failed_rules": 0, "checked_rules": 2, "duration_ms": 1},
        "issues": [],
    }, b'<validationReport isCompliant="true"/>'


def runner_with(**fields):
    """`successful_runner` with some fields of every profile's result replaced."""

    def runner(path, profile, settings):
        result, raw = successful_runner(path, profile, settings)
        return result | fields, raw

    return runner


def failing_runner(issues, **fields):
    """A runner under which every profile fails with `issues`, one failed rule."""
    summary = {"errors": len(issues), "failed_rules": 1, "checked_rules": 2, "duration_ms": 1}
    return runner_with(status="failed", passed=False, issues=issues, summary=summary, **fields)
