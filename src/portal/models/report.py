"""Validation report models: parsed from veraPDF output, stored, and returned by the API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ValidationSummary(BaseModel):
    errors: int = Field(ge=0)
    failed_rules: int = Field(ge=0)
    checked_rules: int | None = Field(default=None, ge=0)
    duration_ms: int = Field(ge=0)


class Issue(BaseModel):
    severity: Literal["error", "warning", "info"] = "error"
    rule_id: str | None = None
    specification: str | None = None
    clause: str | None = None
    test_number: str | None = None
    description: str | None = None
    message: str
    page: int | None = Field(default=None, ge=1)
    location: str | None = None
    category: str | None = None
