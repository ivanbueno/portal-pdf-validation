import copy
import time
import uuid
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from azure.core.exceptions import ResourceNotFoundError
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
        return self.get(*key)

    def save(self, entity):
        key = (entity["PartitionKey"], entity["RowKey"])
        if key not in self.entities or self.entities[key]["_etag"] != entity["_etag"]:
            raise Conflict()
        self.entities[key] = copy.deepcopy(entity) | {"_etag": uuid.uuid4().hex}
        return self.get(*key)

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
        if len(data) != size or not data.startswith(b"%PDF-"):
            raise ValueError("invalid")
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

    def stream(self, name, snapshot):
        return iter([self.objects[(name, snapshot)]])

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


@pytest.fixture
def uploaded(client, store):
    response = client.post("/api/v1/documents", json={"name": "example.pdf", "size": 9})
    assert response.status_code == 201, response.text
    doc = response.json()
    store.put(f"local-development/{doc['id']}/input.pdf", b"%PDF-1.7\n")
    return doc


def successful_runner(path, profile, settings):
    return {
        "profile": profile,
        "status": "passed",
        "passed": True,
        "summary": {"errors": 0, "failed_rules": 0, "checked_rules": 2, "duration_ms": 1},
        "issues": [],
    }, b'<validationReport isCompliant="true"/>'
