from __future__ import annotations

from dataclasses import dataclass
import re
from defusedxml import ElementTree as ET

from ..models.report import SEVERITIES, Issue, ValidationSummary

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


def parse_verapdf_xml(xml_content: str | bytes, duration_ms: int) -> ParsedReport:
    """Parse veraPDF's XML report; pass the raw bytes to avoid decoding a copy first."""
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as exc:
        raise ValueError("veraPDF output is not valid XML") from exc

    # One pass over the whole report finds the validation reports and the extracted pages.
    validation_reports, pages = [], None
    for element in root.iter():
        name = _local_name(element.tag)
        if name == "validationReport":
            validation_reports.append(element)
        elif name == "pages" and pages is None:
            pages = element
    if _local_name(root.tag) == "validationReport":
        validation_reports = [root]
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
        page_count=None if pages is None else sum(1 for _ in _iter_descendants(pages, "page")),
    )


def _parse_report_issues(report: ET.Element) -> list[Issue]:
    parsed_issues: list[Issue] = []

    for rule in _iter_descendants(report, "rule"):
        status = (rule.attrib.get("status") or "").strip().lower()
        if status and status != "failed":
            continue

        # Read once per rule, not per check: one rule can fail tens of thousands of times.
        rule_fields = dict(
            rule_id=_build_rule_id(rule),
            specification=rule.attrib.get("specification"),
            clause=rule.attrib.get("clause"),
            test_number=rule.attrib.get("testNumber"),
            description=_child_text(rule, "description"),
            **_rule_tags(rule),
        )
        rule_location = _child_text(rule, "object")
        fallback_message = rule_fields["description"] or _child_text(rule, "test") or "veraPDF rule failed"

        assertions = [
            assertion
            for assertion in _iter_descendants(rule, "assertion", "check")
            if (assertion.attrib.get("status") or "failed").lower() == "failed"
        ]

        if not assertions:
            parsed_issues.append(_issue(rule_fields, fallback_message, rule_location))
            continue

        for assertion in assertions:
            location = (
                _child_text(assertion, "context") or _child_text(assertion, "location") or rule_location
            )
            message = (
                _child_text(assertion, "errorMessage")
                or _child_text(assertion, "message")
                or _child_text(assertion, "description")
                or fallback_message
            )
            parsed_issues.append(_issue(rule_fields, message, location))

    return parsed_issues


def _issue(rule_fields: dict, message: str, location: str | None) -> Issue:
    page = _extract_page(" ".join(filter(None, [location, message])))
    return Issue(**rule_fields, message=message.strip(), page=page, location=location)


def _rule_tags(rule: ET.Element) -> dict:
    """Severity and categories from the `tags` the validation profile puts on the rule."""
    tags = [tag.strip() for tag in (rule.attrib.get("tags") or "").split(",") if tag.strip()]
    severities = [tag for tag in tags if tag in SEVERITIES]
    return dict(
        severity=max(severities, key=SEVERITIES.index) if severities else None,
        categories=[tag for tag in tags if tag not in SEVERITIES],
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


# Both iterate the element itself: copying its children would make a rule with n checks cost n² to parse.
def _first_child(element: ET.Element, name: str) -> ET.Element | None:
    for child in element:
        if _local_name(child.tag) == name:
            return child
    return None


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name:
            text = (child.text or "").strip()
            if text:
                return text
    return None


def _iter_descendants(element: ET.Element, *names: str):
    """Descendants with any of `names`, in document order, from one walk of the subtree."""
    for descendant in element.iter():
        if _local_name(descendant.tag) in names and descendant is not element:
            yield descendant


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _str_bool(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"
