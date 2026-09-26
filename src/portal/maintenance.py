import logging
import time
from azure.core.exceptions import AzureError
from .cli import run
from .events import log_event
from .domain import dispatch_document, tombstone, prefix
from .storage import Conflict

log = logging.getLogger("portal.maintenance")
# Rows the sweep can act on. Unexpired uploads and finished results need nothing, so the
# service skips them. Full rows (with ETags) are required because the sweep saves them.
CANDIDATES = (
    "kind eq 'document' and ( status eq 'deleted' or status eq 'queued' or status eq 'running'"
    " or expires le @now )"
)


def sweep(store, settings):
    now = time.time()
    failures = 0
    for row in store.rows(where=CANDIDATES, parameters={"now": now}):
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
    log_event(log, "maintenance_finished", failures=failures)
    if failures:
        raise RuntimeError("Maintenance incomplete; see failure count")


def main():
    run(sweep, interval=30)


if __name__ == "__main__":
    main()
