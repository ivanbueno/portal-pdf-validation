"""Public response contracts; Azure metadata and storage keys never leave the service."""

from typing import Literal
from pydantic import BaseModel, Field
from ..config import PROFILES, PROFILE_ALIASES
from .responses import Issue, ValidationSummary


class ProfileResult(BaseModel):
    profile: Literal[PROFILES]
    status: Literal["passed", "failed", "error"]
    passed: bool | None
    summary: ValidationSummary | None = None
    error: str | None = None
    issues: list[Issue] = Field(default_factory=list)
    issue_total: int = 0


class DocumentView(BaseModel):
    id: str
    page_count: int | None = None
    pdf_available: bool = False
    profiles: list[ProfileResult] = Field(default_factory=list)
    validation_profiles: list[Literal[tuple(PROFILE_ALIASES)]] = Field(
        default_factory=lambda: list(PROFILE_ALIASES)
    )
    idempotency_key: str | None = None
    name: str
    size: int | None = None
    status: Literal["uploading", "queued", "running", "passed", "failed", "error"]
    created: float
    expires: float
    submitted: float | None = None
    attempts: int = 0
    passed: bool | None = None
    error: str | None = None
    upload_url: str | None = None
    upload_expires: float | None = None


class DocumentPage(BaseModel):
    items: list[DocumentView]
    total: int
    matching: int
    processed: int
    ua_passed: int
    wcag_passed: int
    pages: int
    active_ids: list[str]


class DocumentDetail(DocumentView):
    results: list[ProfileResult]
    disclaimer: str
    offset: int
    limit: int


class UploadGrant(BaseModel):
    upload_url: str
    upload_expires: float
