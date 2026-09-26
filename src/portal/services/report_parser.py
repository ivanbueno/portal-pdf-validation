from __future__ import annotations

from dataclasses import dataclass
import re
from defusedxml import ElementTree as ET

from ..models.responses import Issue, ValidationSummary

_PAGE_PATTERN = re.compile(r"\bpage\s*(\d+)\b", re.IGNORECASE)
_VERAPDF_PAGE_PATTERN = re.compile(r"(?:^|/)pages\[(\d+)(?:-\d+)?\]")
_VERAPDF_JSON_BBOX_PATTERN = re.compile(r'"p"\s*:\s*(\d+)')
_PAGE_PATTERNS = ((_PAGE_PATTERN, 0), (_VERAPDF_PAGE_PATTERN, 1), (_VERAPDF_JSON_BBOX_PATTERN, 1))


@dataclass(frozen=True)
class ParsedReport:
    passed: bool
    summary: ValidationSummary
    issues: list[Issue]
    page_count: int | None = None


def parse_verapdf_xml(xml_content: str, duration_ms: int) -> ParsedReport:
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as exc:
        raise ValueError("veraPDF output is not valid XML") from exc

    if _local_name(root.tag) == "validationReport":
        validation_reports = [root]
    else:
        validation_reports = [el for el in root.iter() if _local_name(el.tag) == "validationReport"]
    if not validation_reports:
        raise ValueError("veraPDF output does not contain validationReport nodes")

    issues: list[Issue] = []
    total_failed_rules = 0
    total_passed_rules = 0
    total_failed_checks = 0
    compliant_reports = 0

    for report in validation_reports:
        if report.attrib.get("jobEndStatus", "normal") != "normal":
            raise ValueError("veraPDF did not complete validation")
        if _str_bool(report.attrib.get("isCompliant")):
            compliant_reports += 1

        details = _first_child(report, "details")
        if details is not None:
            total_failed_rules += _safe_int(details.attrib.get("failedRules"))
            total_passed_rules += _safe_int(details.attrib.get("passedRules"))
            total_failed_checks += _safe_int(details.attrib.get("failedChecks"))

        issues.extend(_parse_report_issues(report))

    checked_rules = total_failed_rules + total_passed_rules
    if checked_rules == 0:
        checked_rules = None

    errors = total_failed_checks if total_failed_checks > 0 else len(issues)
    passed = compliant_reports == len(validation_reports) and errors == 0

    return ParsedReport(
        passed=passed,
        summary=ValidationSummary(
            errors=errors,
            failed_rules=total_failed_rules,
            checked_rules=checked_rules,
            duration_ms=max(duration_ms, 0),
        ),
        issues=issues,
        page_count=next(
            (
                len(list(_iter_descendants(el, "page")))
                for el in root.iter()
                if _local_name(el.tag) == "pages"
            ),
            None,
        ),
    )


def _parse_report_issues(report: ET.Element) -> list[Issue]:
    parsed_issues: list[Issue] = []

    for rule in _iter_descendants(report, "rule"):
        status = (rule.attrib.get("status") or "").strip().lower()
        if status and status != "failed":
            continue

        rule_id = _build_rule_id(rule)
        fallback_message = (
            _child_text(rule, "description") or _child_text(rule, "test") or "veraPDF rule failed"
        )

        assertions = [
            assertion
            for assertion in list(_iter_descendants(rule, "assertion"))
            + list(_iter_descendants(rule, "check"))
            if (assertion.attrib.get("status") or "failed").lower() == "failed"
        ]

        if not assertions:
            location = _child_text(rule, "object")
            parsed_issues.append(
                _issue_from_message(
                    rule_id=rule_id,
                    rule=rule,
                    message=fallback_message,
                    location=location,
                )
            )
            continue

        for assertion in assertions:
            location = _child_text(assertion, "context") or _child_text(assertion, "location")
            if not location:
                location = _child_text(rule, "object")

            message = (
                _child_text(assertion, "errorMessage")
                or _child_text(assertion, "message")
                or _child_text(assertion, "description")
                or fallback_message
            )
            parsed_issues.append(
                _issue_from_message(
                    rule_id=rule_id,
                    rule=rule,
                    message=message,
                    location=location,
                )
            )

    return parsed_issues


def _issue_from_message(rule_id: str | None, message: str, location: str | None, rule: ET.Element) -> Issue:
    page = _extract_page(" ".join(filter(None, [location, message])))
    category = _infer_category(" ".join(filter(None, [message, rule_id, location])))
    return Issue(
        severity="error",
        rule_id=rule_id,
        specification=rule.attrib.get("specification"),
        clause=rule.attrib.get("clause"),
        test_number=rule.attrib.get("testNumber"),
        description=_child_text(rule, "description"),
        message=message.strip(),
        page=page,
        location=location,
        category=category,
    )


def _build_rule_id(rule: ET.Element) -> str | None:
    explicit = rule.attrib.get("ruleId") or rule.attrib.get("id")
    if explicit:
        return explicit

    parts = [
        rule.attrib.get("specification"),
        rule.attrib.get("clause"),
        rule.attrib.get("testNumber"),
    ]
    compact = [part for part in parts if part]
    if not compact:
        return None
    return ":".join(compact)


def _infer_category(text: str) -> str | None:
    lower = text.lower()
    if any(token in lower for token in ("tag", "structure", "rolemap", "artifact", "marked")):
        return "structure"
    if any(token in lower for token in ("lang", "metadata", "title")):
        return "metadata"
    if any(token in lower for token in ("font", "unicode", "encoding", "glyph")):
        return "font"
    return None


def _extract_page(text: str) -> int | None:
    # Human-readable "page N" is 1-based; veraPDF paths and bounding boxes are 0-based.
    for pattern, page_offset in _PAGE_PATTERNS:
        if match := pattern.search(text or ""):
            page = int(match.group(1)) + page_offset
            return page if page > 0 else None
    return None


def _safe_int(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(value)
    except ValueError:
        return 0


def _first_child(element: ET.Element, name: str) -> ET.Element | None:
    for child in list(element):
        if _local_name(child.tag) == name:
            return child
    return None


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in list(element):
        if _local_name(child.tag) == name:
            text = (child.text or "").strip()
            if text:
                return text
    return None


def _iter_descendants(element: ET.Element, name: str):
    for descendant in element.iter():
        if _local_name(descendant.tag) == name and descendant is not element:
            yield descendant


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _str_bool(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"
