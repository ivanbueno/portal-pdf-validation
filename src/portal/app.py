import json
import logging
import time
import uuid
from urllib.parse import quote
from contextlib import asynccontextmanager
from typing import Annotated
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from azure.core.exceptions import AzureError
from .auth import owner, identity, Identity
from .config import (
    Settings,
    ACTIVE,
    PROFILES,
    TERMINAL,
    DISCLAIMER,
    MAX_FILE,
    MAX_FILES,
    MAX_SELECTION,
    Status,
)
from .domain import (
    FileInput,
    reserve,
    submit,
    get_owned,
    input_blob,
    live_documents,
    document_view,
    document_stats,
    matches,
    public,
    tombstone,
)
from .events import log_event
from .storage import Storage, Conflict
from .services.grouping import group_issues, issue_view
from .middleware import MetadataBodyLimit
from .models.api import DocumentView, DocumentPage, DocumentDetail, StatusFilter, UploadGrant

log = logging.getLogger("portal")
log.setLevel(logging.INFO)
if not log.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(handler)
log.propagate = False


def create_app(settings=None, storage=None):
    settings = settings or Settings()
    storage = storage or Storage(settings)

    @asynccontextmanager
    async def lifespan(app):
        storage.initialize()
        yield

    app = FastAPI(
        title="PDF Validation Portal API",
        version="1.0.0",
        lifespan=lifespan,
        description="Private asynchronous PDF/UA-1 and custom WCAG validation. " + DISCLAIMER,
    )
    app.add_middleware(MetadataBodyLimit)
    app.state.settings, app.state.storage = settings, storage
    Owner = Annotated[str, Depends(owner)]

    def owned_document(doc_id: str, principal: Owner):
        return get_owned(storage, principal, doc_id)

    # The `{doc_id}` path document, which must belong to the caller.
    Document = Annotated[dict, Depends(owned_document)]

    @app.middleware("http")
    async def headers(request: Request, call_next):
        request_id = uuid.uuid4().hex
        start = time.monotonic()
        response = await call_next(request)
        response.headers.update(
            {
                "X-Request-ID": request_id,
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "strict-origin-when-cross-origin",
                "Cache-Control": "no-store",
            }
        )
        if key := getattr(request.state, "idempotency_key", None):
            response.headers["Idempotency-Key"] = key
        # No paths, filenames, tokens, query strings, or exception messages in request logs.
        log_event(
            log,
            "request",
            request_id=request_id,
            status=response.status_code,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
        return response

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse({"detail": "Concurrent change; retry the request"}, status_code=409)

    @app.exception_handler(AzureError)
    async def unavailable(request, exc):
        log_event(log, "storage_unavailable", logging.ERROR, type=type(exc).__name__)
        return JSONResponse(
            {"detail": "Storage temporarily unavailable; retry with the same idempotency key"},
            status_code=503,
            headers={"Retry-After": "5"},
        )

    @app.get("/health/live", include_in_schema=False)
    def live():
        return {"status": "ok"}

    @app.get("/health/ready", include_in_schema=False)
    def ready():
        try:
            storage.container.get_container_properties()
            storage.queue.get_queue_properties()
            next(iter(storage.table.list_entities(results_per_page=1)), None)
        except AzureError:
            raise HTTPException(503, "Storage unavailable")
        return {"status": "ready"}

    @app.get("/api/config", include_in_schema=False)
    def configuration():
        return {
            "local": settings.dev_identity,
            "authMode": "local" if settings.dev_identity else settings.auth_mode,
            "maxFiles": MAX_FILES,
            "maxFileBytes": MAX_FILE,
            "maxSelectionBytes": MAX_SELECTION,
            "disclaimer": DISCLAIMER,
            "profiles": [
                {"id": profile_id, "alias": profile.alias, "label": profile.label, "default": profile.default}
                for profile_id, profile in PROFILES.items()
            ],
            "statuses": {"active": ACTIVE, "terminal": TERMINAL},
        }

    @app.get("/api/session", include_in_schema=False)
    def session(principal: Annotated[Identity, Depends(identity)]):
        return {"name": principal.name, "kind": principal.kind}

    @app.post(
        "/api/v1/documents", status_code=201, response_model=DocumentView, response_model_exclude_none=True
    )
    def create_document(
        body: FileInput,
        principal: Owner,
        request: Request,
        response: Response,
        idempotency_key: Annotated[
            str | None, Header(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
        ] = None,
    ):
        key = idempotency_key or str(uuid.uuid4())
        request.state.idempotency_key = key
        doc = reserve(storage, settings, principal, body, key)
        response.headers["Location"] = f"/api/v1/documents/{doc['id']}"
        return document_view(storage, doc, uploads=True)

    @app.post(
        "/api/v1/documents/{doc_id}/submit",
        status_code=202,
        response_model=DocumentView,
        response_model_exclude_none=True,
    )
    def submit_document(doc: Document):
        return public(submit(storage, settings, doc))

    @app.get("/api/v1/documents", response_model=DocumentPage, response_model_exclude_none=True)
    def list_documents(
        principal: Owner,
        offset: int = Query(0, ge=0),
        limit: int = Query(20, ge=1, le=100),
        q: str = Query("", max_length=240),
        status: StatusFilter = "all",
    ):
        now = time.time()
        rows = live_documents(storage, principal, now)
        rows.sort(key=lambda r: (r["created"], r["id"]), reverse=True)
        query = q.strip().casefold()
        matching = [r for r in rows if matches(r, query, status)]
        items = [public(row) for row in matching[offset : offset + limit]]
        return {"items": items, "total": len(rows), "matching": len(matching)} | document_stats(rows)

    @app.post("/api/v1/documents/{doc_id}/upload-url", response_model=UploadGrant)
    def renew_upload(doc: Document):
        if doc["status"] != Status.UPLOADING:
            raise HTTPException(409, "Upload is already finalized")
        url, expires = storage.upload_url(input_blob(doc))
        return {"upload_url": url, "upload_expires": expires}

    def report(doc):
        if not doc.get("report"):
            return {"results": [], "disclaimer": DISCLAIMER}
        return json.loads(storage.read(doc["report"]))

    @app.get("/api/v1/documents/{doc_id}", response_model=DocumentDetail)
    def get_document(doc: Document, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        result = report(doc)
        for profile in result["results"]:
            issues = profile.get("issues", [])
            profile["issue_total"] = len(issues)
            profile["issues"] = issues[offset : offset + limit]
        return public(doc) | result | {"offset": offset, "limit": limit}

    @app.get("/api/v1/documents/{doc_id}/pdf")
    def view_pdf(doc: Document):
        if not doc.get("snapshot"):
            raise HTTPException(409, "PDF available after submission")
        chunks = storage.stream(input_blob(doc), doc["snapshot"])
        return StreamingResponse(
            chunks,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"inline; filename*=UTF-8''{quote(doc['name'], safe='')}",
                "Content-Length": str(doc["size"]),
            },
        )

    @app.get("/api/v1/documents/{doc_id}/issues")
    def grouped_issues(doc: Document, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100)):
        if doc.get("issues"):
            groups = json.loads(storage.read(doc["issues"]))
        else:
            # Unfinished documents, and reports published before the worker stored issue groups.
            groups = issue_view(group_issues(report(doc)["results"]))
        return {
            "items": groups[offset : offset + limit],
            "total": len(groups),
            "offset": offset,
            "limit": limit,
        }

    @app.get("/api/v1/documents/{doc_id}/reports/{format}")
    def download_report(doc: Document, format: str, profile: str | None = None):
        doc_id = doc["id"]
        if not doc.get("report"):
            raise HTTPException(409, "Report not available yet")
        if format == "json":
            if doc.get("issues"):
                # Stored with its issue groups, so it is served as published.
                body = storage.read(doc["report"])
            else:
                saved = report(doc)
                body = json.dumps(saved | {"issue_groups": group_issues(saved["results"])})
            return Response(
                body,
                media_type="application/json",
                headers={"Content-Disposition": f'attachment; filename="{doc_id}.json"'},
            )
        if format != "xml" or profile not in PROFILES:
            raise HTTPException(422, "Use json, or xml with a supported profile parameter")
        raw = json.loads(doc.get("raw_reports", "{}"))
        if profile not in raw:
            raise HTTPException(404, "XML report unavailable for this profile")
        return Response(
            storage.read(raw[profile]),
            media_type="application/xml",
            headers={"Content-Disposition": f'attachment; filename="{doc_id}-{profile}.xml"'},
        )

    @app.delete("/api/v1/documents/{doc_id}", status_code=204)
    def delete_document(doc: Document):
        tombstone(storage, doc, settings)
        return Response(status_code=204)

    if (settings.dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=settings.dist / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    def index():
        if not (settings.dist / "index.html").exists():
            raise HTTPException(503, "Frontend has not been built; run npm run build in frontend")
        return FileResponse(settings.dist / "index.html")

    return app
