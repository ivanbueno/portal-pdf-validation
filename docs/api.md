# API guide

Base path: `/api/v1`. **Azure Entra Easy Auth** validates authentication before traffic reaches FastAPI. Integrations send an Entra access token for this API: delegated tokens need `Validation.Access`; application tokens need `Validation.Run`. Configure the registration to issue v2 access tokens. Client credentials use scope `api://API_CLIENT_ID/.default` and an administrator-granted application role.

The browser uses Easy Auth's session cookie and `/.auth/login/aad` / `/.auth/logout`, not MSAL or browser-stored tokens. Interactive staff need the `Validation.User` role. Cookie-authenticated mutations also require `X-Requested-With: PDFValidationPortal` (automatically set by the portal); bearer clients do not need that header.

FastAPI authorizes Azure-injected claims and scopes every document to tenant + user/application object ID. Do not send `X-MS-CLIENT-PRINCIPAL` yourself: Azure creates it and strips client-provided values. Direct access bypassing the Easy Auth boundary is unsupported in production. The explicit loopback development identity is only for local use.

`/health/*`, `/api/config`, and static assets are public and contain no document data. `/api/session`, API routes, `/docs`, and `/openapi.json` are protected in Azure. Swagger's Authorize control accepts a bearer access token for API mutations.

## Upload → submit → poll → download

The following example requires curl and jq. Set `BASE` to the portal origin and `TOKEN` to an API access token. Omit the Authorization header only for the explicitly enabled local development mode.

```sh
BASE=https://your-portal.example
PDF_PATH=example.pdf
python3 - "$PDF_PATH" > /tmp/pdf-document.json <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
print(json.dumps({'name': p.name, 'profiles': ['wcag']}))
PY
curl --fail-with-body "$BASE/api/v1/documents" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/pdf-document.json > /tmp/pdf-reservation.json
UPLOAD_URL=$(jq -r '.upload_url' /tmp/pdf-reservation.json)
KEY=$(jq -r .idempotency_key /tmp/pdf-reservation.json)
DOCUMENT_ID=$(jq -r '.id' /tmp/pdf-reservation.json)
curl --fail-with-body -X PUT "$UPLOAD_URL" -H 'x-ms-blob-type: BlockBlob' \
  -H 'Content-Type: application/pdf' --data-binary "@$PDF_PATH"
curl --fail-with-body -X POST "$BASE/api/v1/documents/$DOCUMENT_ID/submit" \
  -H "Authorization: Bearer $TOKEN"
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID" -H "Authorization: Bearer $TOKEN"
# Repeat polling with backoff until the document is passed, failed, or error.
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID/reports/json" \
  -H "Authorization: Bearer $TOKEN" -o report.json
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID/reports/xml?profile=pdfua-1" \
  -H "Authorization: Bearer $TOKEN" -o pdfua.xml
```

### Select validation profiles

Pass `profiles` in the JSON body to `POST /documents`. Accepted values are `wcag` and `pdfua1`; include both values to run both validators. If the property is omitted, the API runs WCAG only.

```json
{"name":"example.pdf"}
```

```json
{"name":"example.pdf","profiles":["wcag"]}
```

```json
{"name":"example.pdf","profiles":["pdfua1"]}
```

```json
{"name":"example.pdf","profiles":["wcag","pdfua1"]}
```

An empty list, unsupported value, or duplicate value returns 422. The reservation response exposes the selected values as `validation_profiles`. Reuse the same profile list along with the same filename and size when retrying a create request with the same idempotency key.

`size` is optional. When omitted, the API reads the uploaded blob's actual size at submission, enforces the 200 MiB limit, and returns the measured size in document responses. If provided, the supplied size is checked against the uploaded file.

Treat upload URLs as temporary credentials. Do not log them or forward your Entra token to Blob Storage. Renew a grant with `POST /documents/{id}/upload-url` while the reservation is active and that file has not been snapshotted. A PUT can be retried; after submission, replacement bytes do not change the validated snapshot.

Every new `POST /documents` without an `Idempotency-Key` header generates a UUID key. The response returns it as `idempotency_key` and in the `Idempotency-Key` header, including handled storage-error responses. Save and reuse it with identical `{name,size?,profiles?}` when retrying creation. Different metadata with the same key returns 409. Separate posts without a key create separate documents, even with identical names and sizes.

A server-generated key cannot deduplicate a retry if the original response was completely lost before the client received the key. Integrations needing that guarantee can optionally generate and persist their own key **before** the first request. Keys accept 1–128 letters, digits, dots, underscores, colons, or hyphens. Keys are scoped to the authenticated owner and retained for the lifetime of the document/tombstone, not indefinitely after cleanup.

Submission is idempotent by document ID; no additional key is needed. Missing/invalid uploads return 409. A 503 after submission may mean work was durably accepted but queue dispatch is pending; retry submission or poll the document. Successful submission always binds processing to the immutable snapshot. Files in a multi-file selection submit independently.

## Resources and results

| Operation | Behavior |
|---|---|
| `POST /documents` | JSON `{name,size?,profiles?}` for one PDF; `size` is optional and checked against the uploaded blob. `profiles` accepts `wcag`, `pdfua1`, or both and defaults to `wcag`. Returns 201 with ID, selected `validation_profiles`, generated key, and upload grant. Optional `Idempotency-Key` request header supports replay. |
| `POST /documents/{id}/submit` | Verifies and snapshots the PDF; returns 202 and current state. |
| `POST /documents/{id}/upload-url` | Renews a grant for an unsubmitted document. |
| `GET /documents?offset=0&limit=20&q=&status=all` | Lists owned, unexpired documents, newest first; limit up to 100. Optional `q` matches filenames case-insensitively and `status` is `all`, `active` (uploading, queued or running), `passed`, `failed` or `error`. `total` counts the documents matching the filters. `stats` covers every document regardless of filters and pagination: `documents`, `processed`, `pending` (queued or running), `wcag_passed`, `pdfua_passed` and `pages`. `processed` is also kept at the top level. |
| `GET /documents/{id}?offset=0&limit=100` | Per-profile results, summaries, paginated issues, and `issue_total`; limit up to 500. |
| `GET /documents/{id}/pdf` | Owner-protected inline PDF stream from the submitted immutable snapshot; 409 before submission. |
| `GET /documents/{id}/issues?offset=0&limit=100` | Groups checks by specification/clause/test across profiles before pagination; returns items and total. Each group includes profile counts and up to 100 occurrences for display. |
| `GET /documents/{id}/reports/json` | Complete normalized results and consolidated `issue_groups`, including every occurrence. |
| `GET /documents/{id}/reports/xml?profile=…` | Original XML for `pdfua-1` or `wcag-2.2`; 404 if that profile could not produce XML. |
| `DELETE /documents/{id}` | 204; immediate access revocation and asynchronous physical cleanup. |

Document states: `uploading`, `queued`, `running`, `passed`, `failed`, `error`. A completed nonconforming file is `failed`, not an HTTP or infrastructure error. On engine failure, profile `passed` is null and `status` is `error`; the document's overall `passed` is false. Rule locations come from veraPDF; page is null when the engine does not supply an unambiguous page number.

Timestamps are Unix seconds. Limits use bytes: 209715200 per file. The portal accepts up to 200 files and 2147483648 bytes per selection; there is no batch resource or API aggregate limit. Actual content is checked during submission; encrypted or structurally malformed PDFs may be accepted as uploads and then finish with a processing error.

HTTP errors: 401 unauthenticated or invalid platform principal; 403 missing role/scope or invalid cookie CSRF header; 404 nonexistent, foreign-owned, deleted, or expired resources; 409 incomplete upload, unavailable report, idempotency mismatch, or concurrent modification; 422 invalid input; 503 unavailable storage. Errors use `{detail: ...}` and carry `X-Request-ID` for request correlation.

Document responses include `pdf_available`, nullable `page_count`, and compact `profiles` with separate outcomes and error counts. Page counts are extracted during new validations; unavailable metadata, including older reports, stays null. Rule issues now include explicit `specification`, `clause`, `test_number`, and `description` when veraPDF supplies them. Grouped issues retain separate specifications, count each profile's checks, and preserve per-check locations. Downloaded XML remains the original validator output.
