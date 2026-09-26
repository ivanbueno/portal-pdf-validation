from pathlib import Path
from typing import Literal
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MAX_FILE = 200 * 1024 * 1024
MAX_FILES = 200
MAX_SELECTION = 2 * 1024 * 1024 * 1024
MAX_ATTEMPTS = 3
PROFILES = ("pdfua-1", "wcag-2.2")
# Short names accepted on requests and returned as `validation_profiles`.
PROFILE_ALIASES = {"pdfua1": "pdfua-1", "wcag": "wcag-2.2"}
PROFILE_SHORT_NAMES = {profile: alias for alias, profile in PROFILE_ALIASES.items()}
PROFILE_LABELS = {"pdfua-1": "PDF/UA-1", "wcag-2.2": "WCAG 2.2"}
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
        if self.profile_timeout <= 0 or self.lease_seconds < 2 * self.profile_timeout + 120:
            raise ValueError("Worker lease must exceed both profile timeouts plus 120 seconds")
        return self
