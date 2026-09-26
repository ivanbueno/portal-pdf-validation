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
from .services.grouping import group_issues, issue_view
from .services.runner import ValidationError, profile_error, run_profile
from .storage import Conflict

log = logging.getLogger("portal.worker")
EXHAUSTED = f"Processing failed after {MAX_ATTEMPTS} attempts"


class Superseded(Exception):
    """This attempt no longer owns the document: it was deleted, expired, or claimed again."""


def active(store, doc):
    current = store.get(doc["PartitionKey"], doc["id"])
    return (
        current
        and current["status"] == Status.RUNNING
        and current.get("run_id") == doc["run_id"]
        and current["expires"] > time.time()
    )


def process_document(store, settings, owner, doc_id, runner=run_profile):
    """Validate one queued document. Returns False when its queue message should be redelivered."""
    doc = store.get(owner, doc_id)
    if not doc or doc["status"] not in PROCESSING or doc["expires"] <= time.time():
        return True
    if doc["status"] == Status.RUNNING and doc.get("lease_until", 0) > time.time():
        return False
    if doc["attempts"] >= MAX_ATTEMPTS:
        doc.update(status=Status.ERROR, error=EXHAUSTED)
        store.save(doc)
        return True
    try:
        doc = claim(store, settings, doc)
    except Conflict:
        return False
    log_event(log, "validation_started", document_id=doc_id, attempt=doc["attempts"])
    try:
        publish(store, doc, *run_profiles(store, settings, doc, runner))
    except Superseded:
        pass
    except (AzureError, OSError):
        release(store, doc)
        log_event(log, "validation_infrastructure_error", logging.ERROR, document_id=doc_id)
        return False
    return True


def claim(store, settings, doc):
    """Start a new attempt under a fresh run ID and lease; raises Conflict if another worker won."""
    return store.save(
        doc
        | dict(
            status=Status.RUNNING,
            attempts=doc["attempts"] + 1,
            run_id=uuid.uuid4().hex,
            lease_until=time.time() + settings.lease_seconds,
        )
    )


def run_prefix(doc):
    """Blobs written by one attempt, so a losing attempt removes exactly its own output."""
    return prefix(doc) + doc["run_id"] + "/"


def run_profiles(store, settings, doc, runner):
    """Validate the snapshot against each requested profile, storing each raw XML report.

    A profile that cannot be validated becomes an error result; the others still run.
    """
    results, raw_reports = [], {}
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "input.pdf"
        store.download(input_blob(doc), path, doc["snapshot"])
        for profile in requested_profiles(doc):
            if not active(store, doc):
                raise Superseded()
            try:
                result, raw = runner(path, profile, settings)
            except ValidationError as exc:
                results.append(profile_error(profile, exc))
                continue
            name = run_prefix(doc) + profile + ".xml"
            store.put(name, raw, "application/xml")
            raw_reports[profile] = name
            results.append(result)
    return results, raw_reports


def summarize(doc_id, results):
    """The stored report for one attempt, and the document fields that summarize it.

    Reports never change once published, so they carry their issue groups: readers never regroup.
    """
    passed = all(r["passed"] is True for r in results)
    page_count = next((r["page_count"] for r in results if r.get("page_count") is not None), None)
    if any(r["status"] == Status.ERROR for r in results):
        status = Status.ERROR
    else:
        status = Status.PASSED if passed else Status.FAILED
    report = dict(
        document_id=doc_id,
        page_count=page_count,
        passed=passed,
        results=results,
        issue_groups=group_issues(results),
        disclaimer=DISCLAIMER,
    )
    fields = dict(
        status=status,
        passed=passed,
        page_count=page_count,
        profile_summaries=json.dumps(
            [{k: v for k, v in r.items() if k not in {"issues", "page_count"}} for r in results]
        ),
    )
    return report, fields


def publish(store, doc, results, raw_reports):
    """Store the report and point the document at it, unless this attempt was superseded."""
    report, fields = summarize(doc["id"], results)
    names = {"report": run_prefix(doc) + "report.json", "issues": run_prefix(doc) + "issues.json"}
    store.put(names["report"], json.dumps(report).encode())
    # The portal pages through this small view instead of downloading the full report.
    store.put(names["issues"], json.dumps(issue_view(report["issue_groups"])).encode())
    if not active(store, doc):
        store.purge(run_prefix(doc))
        return
    # Save against the claim's ETag: deletion or a newer attempt must win this race.
    try:
        store.save(doc | fields | names | {"raw_reports": json.dumps(raw_reports)})
    except Conflict:
        store.purge(run_prefix(doc))
    log_event(log, "validation_finished", document_id=doc["id"], status=fields["status"])


def release(store, doc):
    """After an infrastructure failure, requeue the document, or fail it after the last attempt."""
    if not active(store, doc):
        return
    retry = doc["attempts"] < MAX_ATTEMPTS
    try:
        store.save(
            doc
            | dict(
                status=Status.QUEUED if retry else Status.ERROR,
                dispatched=0.0,
                error="Temporary processing failure" if retry else EXHAUSTED,
            )
        )
    except Conflict:
        pass


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
