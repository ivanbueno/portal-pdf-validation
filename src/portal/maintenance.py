import logging
import time
from azure.core.exceptions import AzureError
from .cli import run
from .events import log_event
from .config import PROCESSING, Status
from .domain import dispatch_document, tombstone, prefix
from .storage import Conflict

log = logging.getLogger("portal.maintenance")
# Rows the sweep can act on. Unexpired uploads and finished results need nothing, so the
# service skips them. Full rows (with ETags) are required because the sweep saves them.
CANDIDATES = "{} or expires le @now".format(
    " or ".join(f"status eq '{status}'" for status in (Status.DELETED, *PROCESSING))
)


def sweep(store, settings):
    now = time.time()
    failures = 0
    for row in store.rows(where=CANDIDATES, parameters={"now": now}):
        try:
            if row["status"] != Status.DELETED and row["expires"] <= now:
                row = tombstone(store, settings, row)
            if row["status"] == Status.DELETED:
                store.purge(prefix(row))
                if row["purge_after"] <= now:
                    store.remove(row)
            elif row["status"] == Status.RUNNING and row.get("lease_until", 0) <= now:
                row.update(status=Status.QUEUED, dispatched=0.0)
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
