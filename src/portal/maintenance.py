import argparse
import json
import logging
import time
from azure.core.exceptions import AzureError
from .config import Settings
from .domain import dispatch_document, tombstone, prefix
from .storage import Storage, Conflict

log = logging.getLogger("portal.maintenance")


def sweep(store, settings):
    now = time.time()
    failures = 0
    for row in store.rows():
        try:
            if row["kind"] != "document":
                continue
            if row["status"] != "deleted" and row["expires"] <= now:
                row = tombstone(store, row, settings)
            if row["status"] == "deleted":
                store.purge(prefix(row))
                if row["purge_after"] <= now:
                    store.remove(row)
            elif row["status"] == "running" and row.get("lease_until", 0) <= now:
                row.update(status="queued", dispatched=0.0)
                row = store.save(row)
            dispatch_document(store, row)
        except Conflict:
            pass
        except AzureError:
            failures += 1
    log.info(json.dumps({"event": "maintenance_finished", "failures": failures}))
    if failures:
        raise RuntimeError("Maintenance incomplete; see failure count")


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("azure").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    store = Storage(settings)
    store.initialize()
    while True:
        sweep(store, settings)
        if not args.loop:
            return
        time.sleep(30)


if __name__ == "__main__":
    main()
