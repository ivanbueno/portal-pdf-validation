import argparse
import json
import logging
from pathlib import Path
import tempfile
import time
import uuid
from azure.core.exceptions import AzureError
from .config import Settings, PROFILES, DISCLAIMER
from .domain import prefix
from .services.runner import run_profile, ValidationError
from .storage import Storage, Conflict

log = logging.getLogger("portal.worker")


def active(store, doc):
    current = store.get(doc["PartitionKey"], doc["id"])
    return (
        current
        and current["status"] == "running"
        and current.get("run_id") == doc["run_id"]
        and current["expires"] > time.time()
    )


def process_document(store, settings, owner, doc_id, runner=run_profile):
    doc = store.get(owner, doc_id)
    if not doc or doc["status"] not in {"queued", "running"}:
        return True
    if doc["expires"] <= time.time():
        return True
    if doc["status"] == "running" and doc.get("lease_until", 0) > time.time():
        return False
    if doc["attempts"] >= 3:
        doc.update(status="error", error="Processing failed after three attempts")
        store.save(doc)
        return True
    doc.update(
        status="running",
        attempts=doc["attempts"] + 1,
        run_id=uuid.uuid4().hex,
        lease_until=time.time() + settings.lease_seconds,
    )
    try:
        doc = store.save(doc)
    except Conflict:
        return False
    log.info(json.dumps({"event": "validation_started", "document_id": doc_id, "attempt": doc["attempts"]}))
    run_prefix = prefix(doc) + doc["run_id"] + "/"
    try:
        results, raw_reports = [], {}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.pdf"
            store.download(prefix(doc) + "input.pdf", path, doc["snapshot"])
            for profile in PROFILES:
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
                            "status": "error",
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
            "error"
            if any(r["status"] == "error" for r in results)
            else ("passed" if report["passed"] else "failed")
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
        log.info(json.dumps({"event": "validation_finished", "document_id": doc_id, "status": status}))
        return True
    except (AzureError, OSError):
        if active(store, doc):
            doc.update(
                status="queued" if doc["attempts"] < 3 else "error",
                dispatched=0.0,
                error="Temporary processing failure"
                if doc["attempts"] < 3
                else "Processing failed after three attempts",
            )
            try:
                store.save(doc)
            except Conflict:
                pass
        log.error(json.dumps({"event": "validation_infrastructure_error", "document_id": doc_id}))
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
        log.error(json.dumps({"event": "invalid_queue_message"}))
        done = True
    if done:
        store.queue.delete_message(message)
    return True


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
        once(store, settings)
        if not args.loop:
            break
        time.sleep(2)


if __name__ == "__main__":
    main()
