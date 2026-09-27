"""Immutable report pages. Legacy reports remain readable until retention expires."""

import json
from ..config import DISCLAIMER
from ..models.api import ProfileSummary
from .grouping import issue_view

ISSUE_CHUNK = 500
GROUP_CHUNK = 100


def summary(result):
    return ProfileSummary.model_validate(result).model_dump(exclude_unset=True)


def write_pages(store, prefix, report):
    def chunks(name, items, size):
        for start in range(0, len(items), size):
            store.put(
                f"{prefix}{name}/{start // size}.json", json.dumps(items[start : start + size]).encode()
            )

    results = []
    for result in report["results"]:
        issues = result.get("issues", [])
        chunks(result["profile"], issues, ISSUE_CHUNK)
        results.append(summary(result) | {"issue_total": len(issues)})
    groups = issue_view(report["issue_groups"])
    chunks("groups", groups, GROUP_CHUNK)
    index = dict(
        results=results,
        group_total=len(groups),
        disclaimer=DISCLAIMER,
        issue_chunk=ISSUE_CHUNK,
        group_chunk=GROUP_CHUNK,
    )
    name = prefix + "index.json"
    store.put(name, json.dumps(index).encode())
    return name


def read_slice(store, prefix, name, total, size, offset, limit):
    end = min(total, offset + limit)
    items = []
    if offset >= end:
        return items
    for page in range(offset // size, (end - 1) // size + 1):
        chunk = json.loads(store.read(f"{prefix}{name}/{page}.json"))
        start = page * size
        items.extend(chunk[max(0, offset - start) : end - start])
    return items


def read_index(store, doc):
    """The paged report's index and the prefix its pages are stored under."""
    name = doc["report_index"]
    return json.loads(store.read(name)), name.rsplit("/", 1)[0] + "/"


def read_results(store, doc, offset, limit):
    if doc.get("report_index"):
        index, prefix = read_index(store, doc)
        results = [
            result
            | {
                "issues": read_slice(
                    store,
                    prefix,
                    result["profile"],
                    result["issue_total"],
                    index["issue_chunk"],
                    offset,
                    limit,
                )
            }
            for result in index["results"]
        ]
        return {"results": results, "disclaimer": index["disclaimer"]}
    result = (
        json.loads(store.read(doc["report"]))
        if doc.get("report")
        else {"results": [], "disclaimer": DISCLAIMER}
    )
    for profile in result["results"]:
        issues = profile.get("issues", [])
        profile.update(issue_total=len(issues), issues=issues[offset : offset + limit])
    return result


def read_groups(store, doc, offset, limit):
    if doc.get("report_index"):
        index, prefix = read_index(store, doc)
        total = index["group_total"]
        items = read_slice(store, prefix, "groups", total, index["group_chunk"], offset, limit)
    else:
        groups = json.loads(store.read(doc["issues"])) if doc.get("issues") else []
        total, items = len(groups), groups[offset : offset + limit]
    return dict(items=items, total=total, offset=offset, limit=limit)
