# Security TODO

Findings from a security review of the code, infrastructure and CI on 2026-09-28. Repository implementation status reviewed on **2026-10-03**. This checklist assumes a first deployment; live Azure and Entra configuration have not been verified. Checked items record completed repository work, not proof that cloud controls have been deployed or tested.

| Finding | Repository status | Remaining work |
| --- | --- | --- |
| H1 — Worker compromise | Partially mitigated: separate identity, scoped storage grants, private network and infrastructure regression tests | Isolate the parser from coordinator credentials; verify permissions and networking in Azure |
| M1 — Delegated authorization | Implemented: role **and** scope required, regression tests, admin-only consent and assignment-required setup steps | Configure and verify Entra during the first deployment |
| M2 — Quotas and resource limits | Open | Per-owner quotas, upload abuse controls and bounded report parsing |
| M3 — Platform authentication boundary | Open; basic forged-header smoke test documented | App-side token validation and broader post-deployment bypass checks |
| L1 — Browser headers | Implemented: CSP, anti-framing, production HSTS, pdf.js evaluation flag and browser tests | Verify the deployed portal through Azure ingress |
| L2 — Non-production configuration | Open | Reject development identity and connection strings in deployed containers |
| L3 — Supply chain | Open; veraPDF archive checksum already pinned | Image digests, action commit SHAs, hashed Python dependencies and production dependency separation |
| Informational | Production Swagger/Redoc disabled | Readiness caching and document-ID validation |

Remaining implementation priority: H1, M2, M3, L2, L3, then the informational items. Complete the deployment verification tasks before first use.

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

Trust boundaries: the Easy Auth edge, the SAS upload path (which bypasses the app), and the worker, which parses hostile PDFs. The templates give the worker its own managed identity and VNet; the API and maintenance use the runtime identity.

## High

### H1. A worker parser exploit would expose every user's documents

Where: [infra/foundation.bicep](../infra/foundation.bicep) (identities), [infra/worker-access.bicep](../infra/worker-access.bicep) (scoped grants), [infra/worker-network.bicep](../infra/worker-network.bicep) (network isolation), [infra/main.bicep](../infra/main.bicep) (worker job)

**Status: partially mitigated in the repository; parser isolation and Azure verification remain open.**

At review time, the worker configuration used the API/maintenance identity to run veraPDF on attacker-supplied PDFs, with account-wide Blob, Queue and Table Data Contributor plus Blob Delegator roles and unrestricted outbound access. The templates now assign a separate worker identity and private network from the first deployment; see [worker isolation](worker-isolation.md) for the permissions and verification procedure. These changes have not been verified on a live Azure deployment.

Remaining impact: a parser exploit can still obtain the worker's credentials, read other tenants' submitted snapshots, overwrite report paths and update shared document metadata. Marking rows deleted/expired can make maintenance purge documents. Direct Blob deletion, input writes and queue-message creation are denied. H1 remains open until Java is isolated from the credential-bearing coordinator or access is restricted to one document/attempt by a trusted broker.

- [x] Give the worker its own managed identity.
- [x] Limit its Blob access to reading `input.pdf` snapshots and writing JSON/XML report paths using ABAC, with no list/delete/delegation grants. Keep only queue consumption and existing-row read/update permissions needed for job coordination.
- [x] Move the worker into a separate VNet-integrated environment and deny general outbound internet traffic. Required Azure platform service tags and DNS remain allowed; this is not an air gap or an exfiltration-proof boundary.
- [x] Add [compiled-template regression tests](../tests/test_worker_infrastructure.py) for worker identity separation, storage operations, Blob conditions, private endpoints and egress rules, and wire them into CI.
- [ ] Complete the [worker deployment verification](worker-isolation.md#deployment-verification) using the worker identity in Azure, including allowed/denied storage operations, private DNS, image pulls, scaling and blocked general internet egress.
- [ ] Isolate the parser from coordinator credentials and restrict each validation to its own document/attempt, including metadata transitions.
- [ ] Run the Java process with a seccomp or read-only filesystem profile where the platform supports it.
- [ ] Track veraPDF releases and patch promptly.

## Medium

### M1. The delegated scope alone grants access without a role assignment

Where: [src/portal/auth.py](../src/portal/auth.py), delegated principal authorization

**Status: code, regression tests and setup documentation implemented; Entra setup and verification pending.**

At review time, `Validation.Access` was accepted without `Validation.User`, and the setup docs allowed user consent with optional enterprise-app assignment. A tenant member or guest could self-consent and reach the API without a role assignment. The code now requires both permissions for delegated requests; browser sessions still require the staff role and application tokens require `Validation.Run`. Setup docs mandate admin-only consent and Assignment required. These Entra settings must be configured during the first deployment; they are not managed by Bicep.

- [x] Require `Validation.User` together with the scope for delegated tokens, including mapped scope claims; reject role-only user bearer requests.
- [x] Document admin-only scope consent and explicit enterprise-application assignment steps in [CI setup](azure-ci.md#assign-users-and-require-assignment) and [manual setup](azure-manual.md), including assigned/unassigned non-administrator checks.
- [x] Add [regression tests](../tests/test_easyauth.py) for scope-only 403, missing/wrong scopes, valid delegated access, browser sessions and application-token isolation.
- [ ] Configure and verify admin-only consent on the deployed `Validation.Access` scope.
- [ ] Configure and verify "Assignment required = Yes" on the portal enterprise application, then test fresh assigned and unassigned non-administrator sessions and delegated tokens.

### M2. No quotas or rate limits (cost and availability abuse)

Where: [src/portal/storage.py](../src/portal/storage.py) (`upload_url`), [src/portal/app.py](../src/portal/app.py) (`create_document`), [infra/main.bicep](../infra/main.bicep) (`maxExecutions: 4`)

**Status: open.** Existing request-size, PDF-size, execution-time and raw-report-size limits do not provide per-owner quotas or bound parsed report memory.

- New document reservations and upload grants have no per-owner quota or rate limit. Idempotent retries reuse the reservation, but a caller can submit unlimited distinct keys.
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

**Status: open; the manual runbook includes a basic forged-header smoke test, but no live boundary verification has been performed.**

The app never validates a token. It trusts `X-MS-CLIENT-PRINCIPAL` whenever `auth_mode=easyauth`, including when `environment=test`. Protection relies on all three of these staying true:

1. Easy Auth stays enabled.
2. Nothing reaches port 8000 directly, whether from other apps in the environment, a future VNet or internal ingress, or a debug proxy.
3. The paths excluded from Easy Auth (`/`, `/assets/*`, `/api/config`) never overlap with routes that read the header.

- [ ] As defence in depth, validate the bearer JWT (or `X-MS-TOKEN-AAD-ACCESS-TOKEN`) in the app against Entra's JWKS, issuer and audience.
- [x] Document a post-deploy forged-principal check against `/api/session` in the [manual runbook](azure-manual.md#71-check-health-and-anonymous-access).
- [ ] Extend post-deploy checks to `/api/v1/documents` and excluded-path prefix variants; verify a forged principal cannot expose protected data or perform mutations. Run the checks against Azure Easy Auth.

## Low

### L1. Browser hardening headers are missing

Where: [src/portal/app.py](../src/portal/app.py) (`standard_headers`), [frontend/src/pdf-document.js](../frontend/src/pdf-document.js)

**Status: implemented and tested locally; Azure ingress verification pending.**

At review time, the portal could be framed by another site, allowing clickjacking of "Delete all documents" despite its confirmation dialog. The app now sends CSP with `frame-ancestors 'none'` and `object-src 'none'`, plus `X-Frame-Options: DENY`, including error and cached-asset responses. Production responses send one-year HSTS, including when TLS terminates at Container Apps ingress. Local HTTP does not set HSTS.

- [x] Add a CSP based on `default-src 'self'` and deny framing/objects. Allow only the configured Blob upload origin in `connect-src`, data images/fonts for PDF rendering, and same-origin workers. The bundled pdf.js worker needs no `blob:` exception; scripts cannot use inline code or dynamic evaluation.
- [x] Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production.
- [x] Pass `isEvalSupported: false` to `pdfjs.getDocument`. CSP independently blocks dynamic JavaScript evaluation.
- [x] Add [response-header tests](../tests/test_static.py), [browser security tests](../frontend/tests/security.spec.js) and [PDF preview coverage](../frontend/tests/previews.spec.js) for the policy and rendering compatibility.
- [ ] Verify CSP, anti-framing and HSTS on the deployed HTTPS portal, including direct uploads and PDF previews through Azure ingress.

Browser tests verify rejected framing, blocked inline scripts/unrelated connections, permitted direct-upload connections, and real PDF previews without CSP violations. The CDN-based Swagger/Redoc UIs are disabled in production. Outside production, only their exact routes use a relaxed CSP for their CDN scripts and inline initialization; they retain framing protection. See [CSP directives](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy) and [HSTS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security).

### L2. Non-production modes fail open if misconfigured

Where: [src/portal/config.py](../src/portal/config.py) (`secure_configuration`)

**Status: open.** Production settings are validated, but there is no independent check for a deployed container running in development mode.

The strict checks only run when `environment == "production"`, which is a plain environment variable. If a deployed container ran with `PDF_ENVIRONMENT=local` and `PDF_DEV_IDENTITY=true`, every authenticated user would share the owner `local-development` and see all documents.

- [ ] Refuse dev identity and storage connection strings when `CONTAINER_APP_NAME` is set, or require a loopback bind.

### L3. Supply chain

**Status: open.** Version pins and the veraPDF archive checksum are present; the tasks below are not implemented.

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
