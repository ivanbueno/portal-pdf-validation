# Security TODO

Findings from a security review of the code, infrastructure and CI on 2026-09-28. The live deployment was not tested. No directly exploitable critical bugs were found. The open items are about limiting the damage from a compromise, one authorization gap that depends on Entra configuration, and limits on resource use.

Recommended order: M1, H1, M2, M3, L1, then the rest.

## System overview

- **Stack:** FastAPI (Python 3.12) serves the API and a Vite single-page app. The browser renders PDFs with pdf.js and pdf-lib. A worker job runs the veraPDF Java CLI in a subprocess. A scheduled maintenance job purges expired data and redispatches stalled work.
- **Azure:** Container Apps with Easy Auth (Entra), Blob Storage (PDFs and reports), Table Storage (document metadata), Queue Storage (jobs), ACR and Log Analytics. Infrastructure is Bicep, deployed by GitHub Actions through OIDC.
- **Uploads:** the API reserves a document and returns a SAS URL for one blob. The client uploads directly to Blob Storage. On submit, the API checks the size and the `%PDF-` header and takes a snapshot, which the worker validates.
- **Authentication:** Easy Auth validates the token and injects `X-MS-CLIENT-PRINCIPAL`. The app parses it, pins the tenant, and requires `Validation.User` for browser sessions, both `Validation.User` and `Validation.Access` for delegated API calls, or `Validation.Run` for applications. The owner ID is `sha256(tenant:kind:oid)`.

```
Browser / API client ──TLS──► Container Apps ingress ──► Easy Auth sidecar ──► FastAPI
                                                                   │  (trusts injected principal)
        │ SAS PUT (one blob, 1h)                                   ▼
        └────────────────────────────────────────────► Blob / Table / Queue
                                                                   ▲
                                   Worker job (veraPDF on untrusted PDFs) ─┘   Maintenance job
```

Trust boundaries: the Easy Auth edge, the SAS upload path (which bypasses the app), and the worker, which parses hostile PDFs. The worker now has its own managed identity and VNet; the API and maintenance retain the runtime identity.

## High

### H1. A worker parser exploit would expose every user's documents

Where: [infra/foundation.bicep](../infra/foundation.bicep) (role assignments), [infra/main.bicep](../infra/main.bicep) (worker job)

At review time, the worker ran veraPDF on attacker-supplied PDFs using the API/maintenance identity, with account-wide Blob, Queue and Table Data Contributor plus Blob Delegator roles and unrestricted outbound access. The templates now assign a separate worker identity and private network; see [worker isolation](worker-isolation.md) for the permissions, deployment migration and verification procedure. These changes have not been verified on a live Azure deployment.

Remaining impact: a parser exploit can still obtain the worker's credentials, read other tenants' submitted snapshots, overwrite report paths and update shared document metadata. Marking rows deleted/expired can make maintenance purge documents. Direct Blob deletion, input writes and queue-message creation are denied. H1 remains open until Java is isolated from the credential-bearing coordinator or access is restricted to one document/attempt by a trusted broker.

- [x] Give the worker its own managed identity.
- [x] Limit its Blob access to reading `input.pdf` snapshots and writing JSON/XML report paths using ABAC, with no list/delete/delegation grants. Keep only queue consumption and existing-row read/update permissions needed for job coordination.
- [x] Move the worker into a separate VNet-integrated environment and deny general outbound internet traffic. Required Azure platform service tags and DNS remain allowed; this is not an air gap or an exfiltration-proof boundary.
- [ ] Isolate the parser from coordinator credentials and restrict each validation to its own document/attempt, including metadata transitions.
- [ ] Run the Java process with a seccomp or read-only filesystem profile where the platform supports it.
- [ ] Track veraPDF releases and patch promptly.

## Medium

### M1. The delegated scope alone grants access without a role assignment

Where: [src/portal/auth.py](../src/portal/auth.py), delegated principal authorization

At review time, `Validation.Access` was accepted without `Validation.User`, and the setup docs allowed user consent with optional enterprise-app assignment. A tenant member or guest could self-consent and reach the API without a role assignment. The code now requires both permissions for delegated requests; browser sessions still require the staff role and application tokens require `Validation.Run`. Setup docs now mandate admin-only consent and Assignment required. Existing Entra configuration still needs separate verification; it is not managed by Bicep.

- [x] Require `Validation.User` together with the scope for delegated tokens, including mapped scope claims; reject role-only user bearer requests.
- [ ] Apply/verify admin-only consent on the live `Validation.Access` scope (required in setup docs).
- [ ] Apply/verify "Assignment required = Yes" on the live enterprise application (required in setup docs).
- [x] Add regression tests for scope-only 403, missing/wrong scopes, valid delegated access, browser sessions and application-token isolation.

### M2. No quotas or rate limits (cost and availability abuse)

Where: [src/portal/storage.py](../src/portal/storage.py) (`upload_url`), [src/portal/app.py](../src/portal/app.py) (`create_document`), [infra/main.bicep](../infra/main.bicep) (`maxExecutions: 4`)

- Every `POST /api/v1/documents` creates a row and a new SAS URL, with no limit.
- A create and write SAS does not limit size. A block blob can be about 190 TiB. The 200 MiB check only runs at submit, and the upload is kept until cleanup either way.
- The SAS stays valid for up to an hour after submit, so the base blob can be replaced with a huge file and is then kept for the 72-hour retention period.
- There is no per-user limit on queued validations. With four worker executions, one user can block everyone else for hours (up to 300 s × 2 profiles and a 2 GiB heap per job).
- A 20 MiB XML report is fully loaded into a DOM and then expanded into issue objects and JSON, which can pressure the 4 GiB worker.

- [ ] Add per-owner limits on documents in `uploading`, `queued` and `running`, and on reservations per hour.
- [ ] Delete the base blob right after the snapshot is taken on submit.
- [ ] Shorten the SAS lifetime.
- [ ] Add a Blob lifecycle or cleanup rule for blobs over the size limit.
- [ ] Put a rate-limiting WAF or Front Door in front of the API.
- [ ] Cap the number of parsed issues or stream the report to bound worker memory.

### M3. All authentication depends on platform configuration

Where: [src/portal/auth.py](../src/portal/auth.py) (`identity`)

The app never validates a token. It trusts `X-MS-CLIENT-PRINCIPAL` whenever `auth_mode=easyauth`, including when `environment=test`. Protection relies on all three of these staying true:

1. Easy Auth stays enabled.
2. Nothing reaches port 8000 directly, whether from other apps in the environment, a future VNet or internal ingress, or a debug proxy.
3. The paths excluded from Easy Auth (`/`, `/assets/*`, `/api/config`) never overlap with routes that read the header.

- [ ] As defence in depth, validate the bearer JWT (or `X-MS-TOKEN-AAD-ACCESS-TOKEN`) in the app against Entra's JWKS, issuer and audience.
- [ ] Add a post-deploy check that a forged principal header on `/api/v1/documents`, including through excluded-path prefixes, returns 401.

## Low

### L1. Browser hardening headers are missing

Where: [src/portal/app.py](../src/portal/app.py) (`standard_headers`), [frontend/src/pdf-document.js](../frontend/src/pdf-document.js)

At review time, the portal could be framed by another site, allowing clickjacking of "Delete all documents" despite its confirmation dialog. The app now sends CSP with `frame-ancestors 'none'` and `object-src 'none'`, plus `X-Frame-Options: DENY`, including error and cached-asset responses. Production responses send one-year HSTS, including when TLS terminates at Container Apps ingress. Local HTTP does not set HSTS.

- [x] Add a CSP based on `default-src 'self'` and deny framing/objects. Allow only the configured Blob upload origin in `connect-src`, data images/fonts for PDF rendering, and same-origin workers. The bundled pdf.js worker needs no `blob:` exception; scripts cannot use inline code or dynamic evaluation.
- [x] Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production.
- [x] Pass `isEvalSupported: false` to `pdfjs.getDocument`. CSP independently blocks dynamic JavaScript evaluation.

Browser tests verify rejected framing, blocked inline scripts/unrelated connections, permitted direct-upload connections, and real PDF previews without CSP violations. The CDN-based Swagger/Redoc UIs are disabled in production. Outside production, only their exact routes use a relaxed CSP for their CDN scripts and inline initialization; they retain framing protection. See [CSP directives](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy) and [HSTS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security).

### L2. Non-production modes fail open if misconfigured

Where: [src/portal/config.py](../src/portal/config.py) (`secure_configuration`)

The strict checks only run when `environment == "production"`, which is a plain environment variable. If a deployed container ran with `PDF_ENVIRONMENT=local` and `PDF_DEV_IDENTITY=true`, every authenticated user would share the owner `local-development` and see all documents.

- [ ] Refuse dev identity and storage connection strings when `CONTAINER_APP_NAME` is set, or require a loopback bind.

### L3. Supply chain

- [ ] Pin the base images in [Dockerfile](../Dockerfile) by digest.
- [ ] Pin GitHub Actions by commit SHA.
- [ ] Generate `requirements.lock` with hashes and install with `--require-hashes`.
- [ ] Split dev tools (`pytest`, `ruff`, `httpx`) out of the production image.

veraPDF is already pinned by SHA-256.

## Informational

- [x] Disable `/docs` and `/redoc` in production so their CDN scripts/inline initialization need no CSP exceptions. Retain `/openapi.json` for integrations; Azure Easy Auth protects it in production. Local interactive documentation remains available.
- [ ] Consider caching `/health/ready`. It needs no authentication and makes three storage calls per request.
- [ ] Validate `doc_id` path parameters against `^[0-9a-f]{32}$`. The Azure SDK escapes keys, so this is hardening only.

## Verified sound

- **Object-level authorization and IDOR:** every document lookup is scoped to the caller's owner partition (`get_owned`). Missing, deleted and other users' documents all return the same 404. Blob paths come from the stored row, never from the client, and `profile` only accepts known values.
- **Command injection:** veraPDF is called with an argument list and no shell. The upload is always saved as `input.pdf` in a temporary directory, and the user's filename never reaches the command line. There is a timeout, a process-group kill, and an output size limit.
- **XXE and XML bombs:** reports are parsed with `defusedxml`.
- **Storage query injection:** Table filters use bound `@parameters`; only constant status values are placed into query strings.
- **SSRF:** the server never fetches a URL supplied by a user.
- **CSRF:** cookie-authenticated requests that change data require `X-Requested-With`, and the API has no CORS. Bearer-token clients cannot be forged from another site.
- **XSS:** the frontend has no `innerHTML`-style sinks. Filenames are rendered with `textContent` and sent in `Content-Disposition` with RFC 5987 encoding. `X-Content-Type-Options: nosniff` is set.
- **Storage:** public blob access and shared-key access are disabled. SAS URLs are user-delegation, one blob, HTTPS only, create and write only.
- **Secrets and logging:** deployment uses OIDC, the Entra client secret is a Bicep secure parameter, and logs exclude filenames, tokens and exception messages.
- **Local setup:** Compose binds only to loopback with a dummy Azurite key, and the container runs as a non-root user.
