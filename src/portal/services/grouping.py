"""Consolidate checks without merging clauses from different specifications."""

from ..models.report import SEVERITIES

# Occurrences per group in the portal's issue view; the JSON report keeps every one.
OCCURRENCE_LIMIT = 100


def group_issues(results):
    groups = {}
    for result in results:
        for issue in result.get("issues", []):
            specification, clause, test = (issue.get(k) for k in ("specification", "clause", "test_number"))
            key = (
                (specification, clause, test)
                if clause and test
                else (result["profile"], issue.get("rule_id") or issue["message"])
            )
            if key not in groups:
                groups[key] = dict(
                    specification=specification,
                    clause=clause,
                    test_number=test,
                    rule_id=issue.get("rule_id"),
                    severity=None,
                    categories=[],
                    message=issue.get("description") or issue["message"],
                    profiles=[],
                    counts={},
                    occurrences=[],
                    count=0,
                )
            group = groups[key]
            # Profiles can tag the same check differently: keep the worst severity and every category.
            severity = issue.get("severity")
            if severity in SEVERITIES and (
                group["severity"] is None or SEVERITIES.index(severity) > SEVERITIES.index(group["severity"])
            ):
                group["severity"] = severity
            for category in issue.get("categories") or []:
                if category not in group["categories"]:
                    group["categories"].append(category)
            profile = result["profile"]
            if profile not in group["profiles"]:
                group["profiles"].append(profile)
            group["counts"][profile] = group["counts"].get(profile, 0) + 1
            group["count"] += 1
            group["occurrences"].append(
                {
                    "profile": profile,
                    "message": issue["message"],
                    "page": issue.get("page"),
                    "location": issue.get("location"),
                }
            )
    return list(groups.values())


def issue_view(groups):
    """The groups as the portal pages through them: each keeps only its first occurrences."""
    return [group | {"occurrences": group["occurrences"][:OCCURRENCE_LIMIT]} for group in groups]
