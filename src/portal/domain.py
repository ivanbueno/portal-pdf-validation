import json
import hashlib
import time
import uuid
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from azure.core.exceptions import ResourceNotFoundError, ResourceModifiedError
from .config import MAX_FILE
from .storage import Conflict


class FileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=240)
    size: int | None = Field(default=None, gt=0, le=MAX_FILE, strict=True)
    profiles: list[str] = Field(default_factory=lambda: ["pdfua-1", "wcag-2.2"], min_length=1)

    @field_validator("profiles")
    @classmethod
    def validation_profiles(cls, value):
        aliases = {"pdfua1": "pdfua-1", "wcag": "wcag-2.2"}
        value = [aliases.get(profile, profile) for profile in value]
        supported = {"pdfua-1", "wcag-2.2"}
        if len(value) != len(set(value)) or not set(value) <= supported:
            raise ValueError("Choose WCAG 2.2, PDF/UA-1, or both")
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
        "validation_profiles": [
            {"pdfua-1": "pdfua1", "wcag-2.2": "wcag"}.get(profile, profile)
            for profile in json.loads(row.get("requested_profiles", json.dumps(["pdfua-1", "wcag-2.2"])))
        ],
        "profiles": json.loads(row.get("profile_summaries", "[]")),
        "pdf_available": bool(row.get("snapshot")),
    }


ACTIVE = {"uploading", "queued", "running"}
TERMINAL = {"passed", "failed", "error"}


def matches(row, query, status):
    if query and query not in row["name"].casefold():
        return False
    if status == "active":
        return row["status"] in ACTIVE
    return status == "all" or row["status"] == status


def document_stats(rows):
    """Workspace totals, so clients never page through every document for summary cards."""
    passed = {"pdfua-1": 0, "wcag-2.2": 0}
    for row in rows:
        for summary in json.loads(row.get("profile_summaries", "[]")):
            if summary.get("status") == "passed" and summary.get("profile") in passed:
                passed[summary["profile"]] += 1
    return {
        "processed": sum(row["status"] in TERMINAL for row in rows),
        "ua_passed": passed["pdfua-1"],
        "wcag_passed": passed["wcag-2.2"],
        "pages": sum(row.get("page_count") or 0 for row in rows),
        "active_ids": [row["id"] for row in rows if row["status"] in {"queued", "running"}],
    }


def prefix(doc):
    return f"{doc['PartitionKey']}/{doc['id']}/"


def get_owned(store, owner, key, kind):
    row = store.get(owner, key)
    if not row or row.get("kind") != kind or row["status"] == "deleted" or row["expires"] <= time.time():
        raise HTTPException(404, "Not found")
    return row


def reserve(store, settings, owner, body, key):
    fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    key = key or str(uuid.uuid4())
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
                    status="uploading",
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
    if doc["status"] == "deleted" or doc["expires"] <= time.time():
        raise HTTPException(409, "This idempotency key belongs to an expired or deleted document")
    return doc


def submit(store, settings, owner, doc_id):
    doc = get_owned(store, owner, doc_id, "document")
    if doc["status"] == "uploading":
        try:
            snapshot_result = store.snapshot(prefix(doc) + "input.pdf", doc.get("size"))
            if isinstance(snapshot_result, tuple):
                snapshot, size = snapshot_result
            else:  # Compatibility with storage adapters that return only the snapshot ID.
                snapshot, size = snapshot_result, doc.get("size")
        except (ResourceNotFoundError, ResourceModifiedError, ValueError):
            raise HTTPException(409, "Upload incomplete or invalid")
        now = time.time()
        # One conditional write binds the snapshot and commits the durable outbox.
        doc.update(
            snapshot=snapshot,
            size=size,
            status="queued",
            submitted=now,
            expires=now + settings.retention_seconds,
            dispatched=0.0,
        )
        doc = store.save(doc)
    dispatch_document(store, doc)
    return get_owned(store, owner, doc_id, "document")


def dispatch_document(store, doc):
    """Reconcile interrupted queue sends; duplicate delivery is fenced by worker ETags."""
    if (
        doc["status"] == "queued"
        and doc["expires"] > time.time()
        and doc.get("dispatched", 0) < time.time() - 120
    ):
        store.enqueue(doc["PartitionKey"], doc["id"])
        doc["dispatched"] = time.time()
        store.save(doc)


def tombstone(store, row, settings):
    row["status"] = "deleted"
    # Keep tombstones beyond all previously issued upload URLs and worker leases.
    row["purge_after"] = time.time() + max(settings.upload_ttl, settings.lease_seconds) + 60
    return store.save(row)


def document_view(store, doc, uploads=False):
    item = public(doc)
    if uploads and doc["status"] == "uploading":
        item["upload_url"], item["upload_expires"] = store.upload_url(prefix(doc) + "input.pdf")
    return item
