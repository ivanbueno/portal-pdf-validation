import json
import logging
from pathlib import Path
import tempfile
import time
import uuid
from azure.core.exceptions import AzureError
from .cli import run
from .config import DISCLAIMER, MAX_ATTEMPTS, PROCESSING, Status
from .events import log_event
from .domain import input_blob, prefix, requested_profiles
from .services.runner import run_profile, ValidationError
from .storage import Conflict

log = logging.getLogger("portal.worker")
EXHAUSTED = "Processing failed after three attempts"


def active(store, doc):
    current = store.get(doc["PartitionKey"], doc["id"])
    return (
        current
        and current["status"] == Status.RUNNING
        and current.get("run_id") == doc["run_id"]
        and current["expires"] > time.time()
    )


def process_document(store, settings, owner, doc_id, runner=run_profile):
    doc = store.get(owner, doc_id)
    if not doc or doc["status"] not in PROCESSING:
        return True
    if doc["expires"] <= time.time():
        return True
    if doc["status"] == Status.RUNNING and doc.get("lease_until", 0) > time.time():
        return False
    if doc["attempts"] >= MAX_ATTEMPTS:
        doc.update(status=Status.ERROR, error=EXHAUSTED)
        store.save(doc)
        return True
    doc.update(
        status=Status.RUNNING,
        attempts=doc["attempts"] + 1,
        run_id=uuid.uuid4().hex,
        lease_until=time.time() + settings.lease_seconds,
    )
    try:
        doc = store.save(doc)
    except Conflict:
        return False
    log_event(log, "validation_started", document_id=doc_id, attempt=doc["attempts"])
    run_prefix = prefix(doc) + doc["run_id"] + "/"
    try:
        results, raw_reports = [], {}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.pdf"
            store.download(input_blob(doc), path, doc["snapshot"])
            for profile in requested_profiles(doc):
                if not active(store, doc):
                    return True
                try:
                    result, raw = runner(path, profile, settings)
                    name = run_prefix + profile + ".xml"
                    store.put(name, raw, "application/xml")
                    raw_reports[profile] = name
                    results.append(result)
                except ValidationError as exc:
                    results.append(
                        {
                            "profile": profile,
                            "status": Status.ERROR,
                            "passed": None,
                            "error": str(exc),
                            "issues": [],
                        }
                    )
        report = {
            "document_id": doc_id,
            "page_count": next((r["page_count"] for r in results if r.get("page_count") is not None), None),
            "passed": all(r["passed"] is True for r in results),
            "results": results,
            "disclaimer": DISCLAIMER,
        }
        name = run_prefix + "report.json"
        store.put(name, json.dumps(report).encode())
        if not active(store, doc):
            store.purge(run_prefix)
            return True
        # Save the original claim ETag: deletion or a newer attempt must win this race.
        status = (
            Status.ERROR
            if any(r["status"] == Status.ERROR for r in results)
            else (Status.PASSED if report["passed"] else Status.FAILED)
        )
        doc.update(
            status=status,
            passed=report["passed"],
            report=name,
            raw_reports=json.dumps(raw_reports),
            page_count=report["page_count"],
            profile_summaries=json.dumps(
                [{k: v for k, v in r.items() if k not in {"issues", "page_count"}} for r in results]
            ),
        )
        try:
            store.save(doc)
        except Conflict:
            store.purge(run_prefix)
        log_event(log, "validation_finished", document_id=doc_id, status=status)
        return True
    except (AzureError, OSError):
        if active(store, doc):
            retry = doc["attempts"] < MAX_ATTEMPTS
            doc.update(
                status=Status.QUEUED if retry else Status.ERROR,
                dispatched=0.0,
                error="Temporary processing failure" if retry else EXHAUSTED,
            )
            try:
                store.save(doc)
            except Conflict:
                pass
        log_event(log, "validation_infrastructure_error", logging.ERROR, document_id=doc_id)
        return False


def once(store, settings):
    messages = store.queue.receive_messages(messages_per_page=1, visibility_timeout=settings.lease_seconds)
    message = next(iter(messages), None)
    if not message:
        return False
    try:
        payload = json.loads(message.content)
        done = process_document(store, settings, payload["owner"], payload["document_id"])
    except (ValueError, KeyError):
        log_event(log, "invalid_queue_message", logging.ERROR)
        done = True
    if done:
        store.queue.delete_message(message)
    return True


def main():
    run(once, interval=2)


if __name__ == "__main__":
    main()
