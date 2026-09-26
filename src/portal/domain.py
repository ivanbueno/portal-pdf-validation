import json
import hashlib
import time
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from azure.core.exceptions import ResourceNotFoundError, ResourceModifiedError
from .config import (
    ACTIVE,
    DEFAULT_PROFILES,
    MAX_FILE,
    PROCESSING,
    PROFILES,
    PROFILE_ALIASES,
    TERMINAL,
    Status,
)
from .storage import Conflict


class FileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=240)
    size: int | None = Field(default=None, gt=0, le=MAX_FILE, strict=True)
    profiles: list[str] = Field(default_factory=lambda: list(DEFAULT_PROFILES), min_length=1)

    @field_validator("profiles")
    @classmethod
    def validation_profiles(cls, value):
        value = [PROFILE_ALIASES.get(profile, profile) for profile in value]
        if len(value) != len(set(value)) or not set(value) <= set(PROFILES):
            raise ValueError(f"Choose one or more of: {', '.join(PROFILE_ALIASES)}")
        return value

    @field_validator("name")
    @classmethod
    def filename(cls, value):
        if any(ord(c) < 32 for c in value) or "/" in value or "\\" in value:
            raise ValueError("Use a plain filename without path separators")
        if not value.lower().endswith(".pdf"):
            raise ValueError("Only .pdf files are supported")
        return value


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
        "profiles": json.loads(row.get("profile_summaries", "[]")),
        "pdf_available": bool(row.get("snapshot")),
    }


def requested_profiles(row):
    # Rows from before profile selection ran every profile.
    return json.loads(row["requested_profiles"]) if "requested_profiles" in row else list(PROFILES)


def is_live(row, now=None):
    return row["status"] != Status.DELETED and row["expires"] > (now or time.time())


# Everything `public`, `matches`, and `document_stats` read from a listed row.
LISTED = sorted(PUBLIC | {"kind", "requested_profiles", "profile_summaries", "snapshot"})


def live_documents(store, owner, now):
    """The owner's live documents: filtered by Table Storage, then re-checked here."""
    rows = store.rows(
        owner,
        where=f"kind eq 'document' and status ne '{Status.DELETED}' and expires gt @now",
        parameters={"now": now},
        select=LISTED,
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
        for summary in json.loads(row.get("profile_summaries", "[]")):
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


def get_owned(store, owner, key, kind):
    row = store.get(owner, key)
    if not row or row.get("kind") != kind or not is_live(row):
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


def submit(store, settings, owner, doc_id):
    doc = get_owned(store, owner, doc_id, "document")
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


def document_view(store, doc, uploads=False):
    item = public(doc)
    if uploads and doc["status"] == Status.UPLOADING:
        item["upload_url"], item["upload_expires"] = store.upload_url(input_blob(doc))
    return item
