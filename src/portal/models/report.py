"""Validation report models: parsed from veraPDF output, stored, and returned by the API."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field

# Severity tags a validation profile can put on a rule, least severe first.
SEVERITIES = ("minor", "major", "critical")

# Reports stored before severities came from profile tags hold "error"; they read as untagged.
Severity = Annotated[
    Literal[SEVERITIES] | None,
    BeforeValidator(lambda value: value if value in SEVERITIES else None),
]


class ValidationSummary(BaseModel):
    errors: int = Field(ge=0)
    failed_rules: int = Field(ge=0)
    checked_rules: int | None = Field(default=None, ge=0)
    duration_ms: int = Field(ge=0)


class Issue(BaseModel):
    severity: Severity = None
    rule_id: str | None = None
    specification: str | None = None
    clause: str | None = None
    test_number: str | None = None
    description: str | None = None
    message: str
    page: int | None = Field(default=None, ge=1)
    location: str | None = None
    # The rule's profile tags other than its severity.
    categories: list[str] = Field(default_factory=list)
