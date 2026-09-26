"""Public response contracts; Azure metadata and storage keys never leave the service."""

from typing import Literal
from pydantic import BaseModel, Field
from ..config import ACTIVE, DEFAULT_PROFILES, PROFILES, PROFILE_ALIASES, TERMINAL
from .responses import Issue, ValidationSummary


def _literal(values):
    """A Literal of plain strings, so OpenAPI enumerates the values."""
    return Literal[tuple(str(value) for value in values)]


ProfileId = _literal(PROFILES)
ProfileAlias = _literal(PROFILE_ALIASES)
DocumentStatus = _literal(ACTIVE + TERMINAL)
# `active` selects every ACTIVE status.
StatusFilter = _literal(("all", "active", *TERMINAL))


class ProfileResult(BaseModel):
    profile: ProfileId
    status: _literal(TERMINAL)
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
    validation_profiles: list[ProfileAlias] = Field(
        default_factory=lambda: [PROFILES[profile].alias for profile in DEFAULT_PROFILES]
    )
    idempotency_key: str | None = None
    name: str
    size: int | None = None
    status: DocumentStatus
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
    passed_by_profile: dict[ProfileId, int]
    ua_passed: int = Field(deprecated="Use passed_by_profile")
    wcag_passed: int = Field(deprecated="Use passed_by_profile")
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
