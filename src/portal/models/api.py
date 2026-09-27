"""Public request and response contracts; Azure metadata and storage keys never leave the service."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from ..config import ACTIVE, DEFAULT_PROFILES, MAX_FILE, PROCESSING, PROFILES, PROFILE_ALIASES, TERMINAL
from .report import Issue, Severity, ValidationSummary


def _literal(values):
    """A Literal of plain strings, so OpenAPI enumerates the values."""
    return Literal[tuple(str(value) for value in values)]


ProfileId = _literal(PROFILES)
ProfileAlias = _literal(PROFILE_ALIASES)
DocumentStatus = _literal(ACTIVE + TERMINAL)
# `active` selects every ACTIVE status.
StatusFilter = _literal(("all", "active", *TERMINAL))


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


class ProfileSummary(BaseModel):
    profile: ProfileId
    status: _literal(TERMINAL)
    passed: bool | None
    summary: ValidationSummary | None = None
    error: str | None = None


class ProfileResult(ProfileSummary):
    issues: list[Issue] = Field(default_factory=list)
    issue_total: int = 0


class DocumentView(BaseModel):
    id: str
    page_count: int | None = None
    pdf_available: bool = False
    profiles: list[ProfileSummary] = Field(default_factory=list)
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


class DocumentActivity(BaseModel):
    id: str
    status: _literal(PROCESSING)
    attempts: int
    expires: float


class ActivityPage(BaseModel):
    items: list[DocumentActivity]


class DocumentPage(BaseModel):
    items: list[DocumentView]
    total: int
    matching: int
    processed: int
    passed_by_profile: dict[ProfileId, int]
    pages: int
    active_ids: list[str]
    activity: list[DocumentActivity]
    next_cursor: str | None = None


class DocumentDetail(DocumentView):
    results: list[ProfileResult]
    disclaimer: str
    offset: int
    limit: int


class IssueOccurrence(BaseModel):
    profile: ProfileId
    message: str
    page: int | None = None
    location: str | None = None


class IssueGroup(BaseModel):
    """One check, merged across profiles; see `services.grouping`."""

    specification: str | None = None
    clause: str | None = None
    test_number: str | None = None
    rule_id: str | None = None
    severity: Severity = None
    categories: list[str] = Field(default_factory=list)
    message: str
    profiles: list[ProfileId]
    counts: dict[ProfileId, int]
    count: int = Field(description="Every occurrence, including those beyond `occurrences`")
    occurrences: list[IssueOccurrence] = Field(
        description="The first occurrences only; the JSON report lists every one"
    )


class IssuePage(BaseModel):
    items: list[IssueGroup]
    total: int
    offset: int
    limit: int


class DeletedDocuments(BaseModel):
    deleted: int


class UploadGrant(BaseModel):
    upload_url: str
    upload_expires: float
