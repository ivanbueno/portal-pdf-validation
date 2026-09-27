"""Streaming workspace scans and stable keyset pagination over document metadata."""

import base64
import binascii
import heapq
import json
import math
from ..config import PROCESSING, PROFILES, TERMINAL, Status
from ..domain import iter_live, matches, profile_summaries, public

ACTIVITY_FIELDS = ["id", "status", "attempts", "expires"]


def activity_item(row):
    return {key: row[key] for key in ACTIVITY_FIELDS}


def document_activity(store, owner, now):
    processing = " or ".join(f"status eq '{status}'" for status in PROCESSING)
    rows = iter_live(store, owner, now, where=processing, select=ACTIVITY_FIELDS)
    return sorted(
        (activity_item(row) for row in rows if row["status"] in PROCESSING),
        key=lambda row: row["id"],
    )


def decode_cursor(cursor, query, status):
    try:
        created, doc_id, saved_query, saved_status = json.loads(base64.urlsafe_b64decode(cursor))
        if (
            isinstance(created, bool)
            or not isinstance(created, (int, float))
            or not math.isfinite(created)
            or not isinstance(doc_id, str)
            or not 1 <= len(doc_id) <= 128
            or (saved_query, saved_status) != (query, status)
        ):
            raise ValueError()
        return created, doc_id
    except (ValueError, TypeError, OverflowError, binascii.Error, UnicodeError):
        raise ValueError("Invalid cursor for these filters") from None


def document_page(store, owner, now, offset, limit, query, status, cursor=None):
    if cursor and offset:
        raise ValueError("Use either cursor or offset")
    boundary = decode_cursor(cursor, query, status) if cursor else None
    totals = dict(total=0, matching=0, processed=0, pages=0, passed_by_profile=dict.fromkeys(PROFILES, 0))
    activity = []

    def candidates():
        for row in iter_live(store, owner, now):
            totals["total"] += 1
            totals["processed"] += row["status"] in TERMINAL
            totals["pages"] += row.get("page_count") or 0
            for summary in profile_summaries(row):
                if summary.get("status") == Status.PASSED and summary.get("profile") in PROFILES:
                    totals["passed_by_profile"][summary["profile"]] += 1
            if row["status"] in PROCESSING:
                activity.append(activity_item(row))
            if matches(row, query, status):
                totals["matching"] += 1
                if boundary is None or (row["created"], row["id"]) < boundary:
                    yield row

    # Cursor requests retain only limit+1 rows, rather than sorting the whole owner.
    selected = heapq.nlargest(offset + limit + 1, candidates(), key=lambda row: (row["created"], row["id"]))
    rows = selected[offset : offset + limit]
    next_cursor = None
    if len(selected) > offset + limit:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps([last["created"], last["id"], query, status]).encode()
        ).decode()
    activity.sort(key=lambda row: row["id"])
    return totals | dict(
        items=[public(row) for row in rows],
        next_cursor=next_cursor,
        activity=activity,
    )
