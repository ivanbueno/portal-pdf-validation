import json
import hashlib
import time
from fastapi import HTTPException
from azure.core.exceptions import ResourceNotFoundError, ResourceModifiedError
from .config import ACTIVE, PROCESSING, PROFILES, TERMINAL, Status
from .storage import Conflict


PUBLIC = {
    "id",
    "idempotency_key",
    "name",
    "size",
    "status",
    "created",
    "submitted",
    "expires",
    "error",
    "attempts",
    "passed",
    "page_count",
}


def public(row):
    return {key: value for key, value in row.items() if key in PUBLIC} | {
        "validation_profiles": [PROFILES[profile].alias for profile in requested_profiles(row)],
        "profiles": profile_summaries(row),
        "pdf_available": bool(row.get("snapshot")),
    }


# Table Storage has no list or map properties, so these columns hold JSON.
def requested_profiles(row):
    return json.loads(row["requested_profiles"])


def profile_summaries(row):
    """Each profile's published result without its issues; empty until validation finishes."""
    return json.loads(row.get("profile_summaries", "[]"))


def raw_reports(row):
    """The published XML report's blob name by profile ID; a profile that errored has none."""
    return json.loads(row.get("raw_reports", "{}"))


def is_live(row, now=None):
    return row["status"] != Status.DELETED and row["expires"] > (now or time.time())


# Everything `public`, `matches`, and `document_stats` read from a listed row.
LISTED = sorted(PUBLIC | {"kind", "requested_profiles", "profile_summaries", "snapshot"})


def live_documents(store, owner, now, select=LISTED):
    """The owner's live documents: filtered by Table Storage, then re-checked here.

    Rows read with the default `select` are partial and cannot be saved; pass None for full rows.
    """
    rows = store.rows(
        owner,
        where=f"kind eq 'document' and status ne '{Status.DELETED}' and expires gt @now",
        parameters={"now": now},
        select=select,
    )
    return [row for row in rows if row.get("kind") == "document" and is_live(row, now)]


def matches(row, query, status):
    if query and query not in row["name"].casefold():
        return False
    if status == "active":
        return row["status"] in ACTIVE
    return status == "all" or row["status"] == status


def document_stats(rows):
    """Workspace totals, so clients never page through every document for summary cards."""
    passed = dict.fromkeys(PROFILES, 0)
    for row in rows:
        for summary in profile_summaries(row):
            if summary.get("status") == Status.PASSED and summary.get("profile") in passed:
                passed[summary["profile"]] += 1
    return {
        "processed": sum(row["status"] in TERMINAL for row in rows),
        "passed_by_profile": passed,
        # Deprecated per-profile fields, kept for existing API clients.
        "ua_passed": passed["pdfua-1"],
        "wcag_passed": passed["wcag-2.2"],
        "pages": sum(row.get("page_count") or 0 for row in rows),
        "active_ids": [row["id"] for row in rows if row["status"] in PROCESSING],
    }


def prefix(doc):
    return f"{doc['PartitionKey']}/{doc['id']}/"


def input_blob(doc):
    return prefix(doc) + "input.pdf"


def get_owned(store, owner, doc_id):
    """The owner's live document; anything else is indistinguishable from a missing one."""
    row = store.get(owner, doc_id)
    if not row or row.get("kind") != "document" or not is_live(row):
        raise HTTPException(404, "Not found")
    return row


def reserve(store, settings, owner, body, key):
    fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    doc_id = hashlib.sha256(f"{owner}:{key}".encode()).hexdigest()[:32]
    doc = store.get(owner, doc_id)
    if not doc:
        now = time.time()
        try:
            doc = store.insert(
                dict(
                    PartitionKey=owner,
                    RowKey=doc_id,
                    id=doc_id,
                    kind="document",
                    name=body.name,
                    **({"size": body.size} if body.size is not None else {}),
                    requested_profiles=json.dumps(body.profiles),
                    status=Status.UPLOADING,
                    created=now,
                    expires=now + settings.upload_ttl,
                    attempts=0,
                    idempotency_key=key,
                    fingerprint=fingerprint,
                )
            )
        except Conflict:
            doc = store.get(owner, doc_id)
    if doc.get("fingerprint") != fingerprint:
        raise HTTPException(409, "Idempotency key was already used for different document metadata")
    if not is_live(doc):
        raise HTTPException(409, "This idempotency key belongs to an expired or deleted document")
    return doc


def submit(store, settings, doc):
    if doc["status"] == Status.UPLOADING:
        try:
            snapshot, size = store.snapshot(input_blob(doc), doc.get("size"))
        except (ResourceNotFoundError, ResourceModifiedError, ValueError):
            raise HTTPException(409, "Upload incomplete or invalid")
        now = time.time()
        # One conditional write binds the snapshot and commits the durable outbox.
        doc.update(
            snapshot=snapshot,
            size=size,
            status=Status.QUEUED,
            submitted=now,
            expires=now + settings.retention_seconds,
            dispatched=0.0,
        )
        doc = store.save(doc)
    return dispatch_document(store, doc)


def dispatch_document(store, doc):
    """Reconcile interrupted queue sends; duplicate delivery is fenced by worker ETags.

    Returns the current row: the saved one after a send, otherwise `doc` unchanged.
    """
    now = time.time()
    if doc["status"] == Status.QUEUED and doc["expires"] > now and doc.get("dispatched", 0) < now - 120:
        store.enqueue(doc["PartitionKey"], doc["id"])
        doc["dispatched"] = now
        return store.save(doc)
    return doc


def tombstone(store, row, settings):
    row["status"] = Status.DELETED
    # Keep tombstones beyond all previously issued upload URLs and worker leases.
    row["purge_after"] = time.time() + max(settings.upload_ttl, settings.lease_seconds) + 60
    return store.save(row)


def delete_all(store, settings, owner):
    """Tombstone every live document of the owner, as a single delete would; returns the count.

    A row changed meanwhile (say, by a worker publishing) is re-read and retried. One that keeps
    changing raises Conflict, and the caller's retry skips documents already deleted.
    """
    deleted = 0
    for row in live_documents(store, owner, time.time(), select=None):
        for _ in range(3):
            try:
                tombstone(store, row, settings)
                deleted += 1
                break
            except Conflict:
                row = store.get(owner, row["id"])
                if not row or not is_live(row):
                    break  # Deleted or expired meanwhile.
        else:
            raise Conflict()
    return deleted


def document_view(store, doc, uploads=False):
    item = public(doc)
    if uploads and doc["status"] == Status.UPLOADING:
        item["upload_url"], item["upload_expires"] = store.upload_url(input_blob(doc))
    return item
