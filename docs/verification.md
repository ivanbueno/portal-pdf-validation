# Verification record

Verified locally on September 25, 2026. No Azure resources were provisioned. Updated for screenshot-inspired document rows, PDF viewing, page counts, consolidated issues, the document-only API, and generated idempotency keys; Entra Easy Auth remains enabled for Azure deployment.

| Check | Result |
|---|---|
| Python application suite | 64 passed using the production Python 3.12 container and pinned Java 21/veraPDF 1.30.2 engine. Also passed on local Python 3.14. |
| Azure SDK integration against Azurite | 1 passed: SAS upload, immutable snapshot after overwrite, real dual-profile worker, JSON/XML results, extracted page count, owner-protected immutable PDF stream, ETag conflict, expired SAS rejection, and deletion access revocation. |
| Chromium browser acceptance | 5 passed: mixed pass/fail documents, upload, real validation, refresh recovery, report download, filtering, deletion, keyboard disclosure/dropdown controls, expanded mobile layout, dark theme, independent submission after a failed upload, retry without duplicate creation, and simulated Easy Auth login/logout/session-expiry/unassigned-user flows. |
| Accessibility | axe WCAG 2 A/AA and 2.1 AA checks passed in tested light and dark views. Mobile document has no horizontal viewport overflow at 200% text size. This is automated coverage, not a complete manual accessibility audit. |
| Real fixtures | Official veraPDF corpus pass fixture passes both profiles; failing fixture fails PDF/UA-1 while passing custom WCAG; malformed and password-encrypted inputs produce processing errors. |
| Resource and recovery tests | Single-file limits, invalid uploads, request body limit, generated keys, idempotency replay/conflicts, preview data migration, owner isolation, Easy Auth principal/role authorization and cookie CSRF protection, output/time bounds, partial profile errors, queue failure recovery, worker lease recovery, three-attempt limit, deletion race, and expiration cleanup pass. |
| Container | Complete multi-stage Docker image builds and runs locally as UID 10001; official veraPDF installer checksum verified during build. |
| Frontend | Vite production build, Prettier checks, and dependency audit pass. |
| Python quality | Ruff lint and formatting checks pass. |
| Azure infrastructure | Bicep 0.47.16 compiles foundation/main templates without diagnostics. |

Not executed: real Entra browser/client-credentials login, Azure provisioning, managed-identity RBAC propagation, cloud queue scaling, cloud alert delivery, or a full-load run at the 200-file/2 GiB portal selection limit or 200 MiB single-file limit. Single-file size boundaries are covered by request tests; representative document validation and browser flows use small real PDFs. Follow the Azure smoke checklist before production release.

Authentication checks now exercise trusted Azure principal headers; actual token signature, expiry, issuer, audience validation and header sanitization are performed by Easy Auth and require the Azure smoke checks. Compiled Bicep confirms the enabled platform gate, Return401 behavior, protected API routes, and secure client-secret parameter.

The Python test environment emits a Starlette warning about the future `httpx2` test-client migration; it does not affect the running portal or test outcomes.

The updated report presentation was checked in full Chromium (including its PDF viewer): filename opens a new tab, date/page metadata renders, profile results are separate, JSON download and dropdown deletion work, clause/test failures consolidate with locations, and disclosure state survives refresh/filtering. Backend tests cover cross-owner PDF denial, deletion revocation, grouping before pagination, complete JSON occurrence export, distinct specifications, legacy rule IDs, and page extraction. Full Chromium is selected in Playwright because the lightweight headless shell does not include the PDF viewer. Desktop and expanded dark mobile screenshots were inspected locally.
