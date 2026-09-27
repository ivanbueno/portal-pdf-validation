from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MAX_FILE = 200 * 1024 * 1024
MAX_FILES = 200
MAX_SELECTION = 2 * 1024 * 1024 * 1024
MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class Profile:
    label: str
    # Short name accepted on requests and returned as `validation_profiles`.
    alias: str
    # Built-in veraPDF flavour; None validates against the configured `Settings.profile_path`.
    flavour: str | None = None
    # Run when a request omits `profiles`.
    default: bool = False


# Every validation profile by ID, in the portal's display order. Requests, reports, workspace
# stats, and the portal's options and summary cards derive from it.
PROFILES = {
    "wcag-2.2": Profile(label="WCAG 2.2", alias="wcag", default=True),
    "pdfua-1": Profile(label="PDF/UA-1", alias="pdfua1", flavour="ua1"),
}
PROFILE_ALIASES = {profile.alias: profile_id for profile_id, profile in PROFILES.items()}
DEFAULT_PROFILES = tuple(profile_id for profile_id, profile in PROFILES.items() if profile.default)


class Status(StrEnum):
    """Document lifecycle. Members are strings, so stored and JSON values stay plain text."""

    UPLOADING = "uploading"
    QUEUED = "queued"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    ERROR = "error"
    DELETED = "deleted"


def outcome(passed):
    """The status of a validation that completed, by whether it passed."""
    return Status.PASSED if passed else Status.FAILED


# Awaiting an upload or a worker.
ACTIVE = (Status.UPLOADING, Status.QUEUED, Status.RUNNING)
# Submitted and not yet finished: what workers pick up and the portal's progress bar waits on.
PROCESSING = (Status.QUEUED, Status.RUNNING)
# Validation finished; also the per-profile result outcomes.
TERMINAL = (Status.PASSED, Status.FAILED, Status.ERROR)

DISCLAIMER = (
    "Automated checks do not establish full accessibility or WCAG conformance. Manual review is required."
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PDF_", env_file=".env", extra="ignore")
    environment: str = "production"
    dev_identity: bool = False
    tenant_id: str = ""
    audience: str = ""
    auth_mode: Literal["disabled", "easyauth"] = "disabled"
    user_role: str = "Validation.User"
    scope: str = "Validation.Access"
    app_role: str = "Validation.Run"
    storage_account: str = ""
    storage_connection_string: str = ""
    public_blob_endpoint: str = ""
    container: str = "documents"
    table: str = "validation"
    queue: str = "validation"
    profile_path: Path = Path("profiles/WCAG-2-2-Complete.xml")
    verapdf_jar: Path = Path("/opt/verapdf/cli.jar")
    java: str = "java"
    profile_timeout: int = 300
    report_limit: int = 20 * 1024 * 1024
    retention_seconds: int = 72 * 3600
    upload_ttl: int = 3600
    lease_seconds: int = 900
    dist: Path = Path("frontend/dist")

    @model_validator(mode="after")
    def secure_configuration(self):
        if self.environment not in {"local", "production", "test"}:
            raise ValueError("Unknown environment")
        if self.environment == "production":
            if self.dev_identity or self.storage_connection_string or self.auth_mode != "easyauth":
                raise ValueError("Production requires Azure Easy Auth and managed identity")
            if not all((self.tenant_id, self.audience, self.storage_account)):
                raise ValueError("Production requires tenant, audience, and storage account")
        # One worker runs a document's profiles sequentially within one lease.
        if self.profile_timeout <= 0 or self.lease_seconds < len(PROFILES) * self.profile_timeout + 120:
            raise ValueError("Worker lease must exceed every profile timeout combined plus 120 seconds")
        return self
