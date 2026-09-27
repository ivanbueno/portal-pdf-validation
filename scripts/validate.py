"""Usage: PDF_API_TOKEN=... python scripts/validate.py https://portal.example file.pdf [more.pdf]."""

import json
import os
import sys
import time
from pathlib import Path
import httpx


def main():
    base, *names = sys.argv[1:]
    if not names:
        raise SystemExit("Supply at least one PDF")
    headers = {"Authorization": "Bearer " + os.environ["PDF_API_TOKEN"]}
    docs = []
    with httpx.Client(base_url=base.rstrip("/") + "/api/v1/", headers=headers, timeout=60) as api:
        # The server owns the document lifecycle; an absolute URL bypasses the /api/v1 base.
        response = api.get(base.rstrip("/") + "/api/config")
        response.raise_for_status()
        finished = set(response.json()["statuses"]["terminal"])
        # Never forward the Entra token to Blob Storage.
        with httpx.Client(timeout=1800) as blobs:
            for name in names:
                path = Path(name)
                response = api.post("documents", json={"name": path.name, "size": path.stat().st_size})
                response.raise_for_status()
                doc = response.json()
                # Keep this key if you implement creation retries. A new key creates a new document.
                print("Reserved", doc["id"], "idempotency key", doc["idempotency_key"])
                with path.open("rb") as stream:
                    response = blobs.put(
                        doc["upload_url"],
                        content=stream,
                        headers={"x-ms-blob-type": "BlockBlob", "Content-Length": str(path.stat().st_size)},
                    )
                    response.raise_for_status()
                response = api.post(f"documents/{doc['id']}/submit")
                response.raise_for_status()
                docs.append(doc)
        pending = {doc["id"] for doc in docs}
        delay = 2
        while pending:
            for doc_id in list(pending):
                response = api.get(f"documents/{doc_id}/status")
                response.raise_for_status()
                doc = response.json()
                if doc["status"] not in finished:
                    continue
                pending.remove(doc_id)
                response = api.get(f"documents/{doc_id}/reports/json")
                if response.is_success:
                    Path(doc_id + ".json").write_text(json.dumps(response.json(), indent=2))
                print(doc["name"], doc["status"])
            if pending:
                time.sleep(delay)
                delay = min(delay * 1.5, 15)


if __name__ == "__main__":
    main()
