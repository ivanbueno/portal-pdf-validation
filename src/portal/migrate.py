"""One-time migration of pre-release batch records. Stop API/workers/maintenance first."""

from .config import Settings
from .domain import tombstone
from .storage import Storage


def migrate(store, settings):
    for doc in store.rows():
        if doc.get("kind") != "document" or "batch_id" not in doc:
            continue
        parent = store.get(doc["PartitionKey"], doc["batch_id"])
        if doc["status"] != "deleted":
            if not parent or parent["status"] == "deleted":
                doc = tombstone(store, doc, settings)
            else:
                doc["expires"] = parent["expires"]
                if parent["status"] == "submitted":
                    doc["submitted"] = parent["submitted"]
                    if doc["status"] == "uploading" and doc.get("snapshot"):
                        doc.update(status="queued", dispatched=0.0)
        del doc["batch_id"]
        store.save(doc)
    for row in store.rows():
        if row.get("kind") == "batch":
            store.remove(row)


if __name__ == "__main__":
    settings = Settings()
    store = Storage(settings)
    store.initialize()
    migrate(store, settings)
