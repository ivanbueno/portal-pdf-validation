# PDF Validation Portal: Tier 1 Support Runbook

## 1. Application Information

| Item | Information |
|---|---|
| Application name | PDF Validation Portal |
| Website URL | [Production website](https://pdfval-api.calmocean-f7286a46.westus2.azurecontainerapps.io) |
| Azure Container App name | `pdfval-api` |
| Resource group | `pdf-validation-prod` |
| Production environment | GitHub environment `production`; Azure Container Apps environment `pdfval-env` |
| Test or staging environment | **TBD: Confirm with application owner**. No staging deployment is defined in the reviewed workflow. |
| Application owner | **TBD: Confirm with application owner** |
| Technical contact | **TBD: Confirm with application owner** |
| Support contact | **TBD: Confirm with application owner** |
| Escalation contact | **TBD: Confirm with application owner** |
| Subscription and directory | **TBD: Confirm with application owner** |
| Azure region | Production hostname identifies `westus2`. Confirm on the resource's Overview page. |
| Application logs | Log Analytics workspace `pdfval-logs` |
| Background processing | Container Apps jobs `pdfval-worker` and `pdfval-maintenance` |
| Data services | Azure Storage: private Blob container `documents`, Queue `validation`, Table `validation`. Storage account name: **TBD: Confirm with application owner**. |
| Application Insights resource | Not provisioned by this repository. Any separately configured resource: **TBD: Confirm with application owner**. |
| Custom domain | **TBD: Confirm with application owner**. None defined in the reviewed templates. |
| Restart approver and incident response targets | **TBD: Confirm with application owner** |
| Deployment history | [Deploy Azure workflow](https://github.com/ivanbueno/portal-pdf-validation/actions/workflows/deploy.yml) |

### How it works

`User > Website and Microsoft sign-in > Container App > Azure Storage > PDF validation jobs > Results`

The website accepts PDFs and displays accessibility checks. Microsoft Entra ID controls sign-in. An API is the part of the application that receives requests from the website or approved integrations. PDFs upload directly to private storage. A queue holds work until a background job checks the PDF. Table Storage records ownership and progress. There is no SQL database defined in this deployment.

Files and reports become inaccessible after 72 hours. Unsubmitted upload reservations expire after one hour. A result of **failed** means a PDF did not meet a validation rule; **error** means processing had a problem. A failed accessibility check alone is not a website outage. See [How it works](how-it-works.md) and [Using the portal](user-guide.md).

### Before an incident

Have the owner complete all TBD entries, confirm the production subscription, and provide the support team's approved escalation route. Use your own work account and approved read access. Log access and Entra sign-in log access may require separate permissions. If a page says access denied, record the page and escalate; do not grant yourself access.

Action labels used below:

- **Safe to check:** Read status, logs, metrics and deployment history using existing permissions.
- **Safe to do:** Refresh a page once, try a private browser window, or collect a sanitized ticket. Do not interrupt an active upload.
- **Use caution:** A production action requires explicit approval recorded in the incident ticket. This runbook does not grant restart or change approval.
- **Escalate:** Stop changes and route the incident to the responsible team. Continue harmless evidence collection if it will not delay urgent response.

Open the [Azure Portal](https://portal.azure.com) with your work account. The paths below start there. To find a service, use the search box at the top, type its name, and select the service result. Expand the named section in the resource's left menu. If your menu uses a slightly different label, use its search box for the final page name. Do not substitute another resource when a page is missing.

Use one time window across all checks: start 15 minutes before the reported problem and end now. Record UTC, or include the time zone with every local time. An empty chart is **unknown**, not proof of good health.

## 2. Azure Basics

All entries in this table are **Safe to check**. Reading settings does not authorize editing them.

| Feature | What it is | Why support might look at it | Where to find it |
|---|---|---|---|
| Azure Portal | Microsoft's website for viewing and managing Azure services. | Find the affected resources. | `Azure Portal > top search box > Resource groups > pdf-validation-prod` |
| Container Apps | The service running this website and API. | Check the running version, logs and resources. | `Azure Portal > Container Apps > pdfval-api > Overview` |
| Resource Group | A named collection of related Azure resources. | Find the application, storage, jobs and logs together. | `Azure Portal > Resource groups > pdf-validation-prod > Overview` |
| Application Insights | Optional monitoring that tracks requests, errors and calls to other services. | Investigate recent errors if the owner confirms it is connected. | Conditional: `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures` |
| Log Analytics | A place to search saved logs. | Find errors from the app, worker and maintenance job. | `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs` |
| Log Stream | A live view of messages produced by the application or Azure. | Watch errors while reproducing a problem. | `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream` |
| Metrics | Charts of resource use, requests and failures. | Compare the incident with normal operation. | `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics` |
| Activity Log | A history of Azure management actions. | See who changed a resource and when. It does not show every user request. | `Azure Portal > Resource groups > pdf-validation-prod > Activity log` |
| Deployment | An update that installs code or resource settings. | Compare an update's time with the incident start. | `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`; also the GitHub workflow linked above. |
| Application Settings | Values that tell the application how to run. Container Apps calls these environment variables. | Identify a recent change, without exposing values. | `Azure Portal > Container Apps > pdfval-api > Application > Containers > api > Environment variables` |
| Revision and replica | A revision is a deployed version; a replica is one running copy of that version. | Find the version serving users and check whether its copies are healthy. | `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas` |

Do not select Edit, Save, Apply or Create when inspecting settings.

## 3. Website Is Down

**Safe to check.** If everyone is affected, notify Tier 2 immediately and follow Section 12. Do not finish the whole checklist before escalating.

| Step | Where to click and what to do | What the result means |
|---|---|---|
| 1. Open the website. | Open a new browser tab and click the production website link in Section 1. | A sign-in card can be normal. A blank page, connection failure or error needs checking. |
| 2. Confirm the problem. | Try the same page once in a private browser window using your own authorized account. If an upload is active, do not refresh it. | One browser failing can be a local session issue. Both failing suggests a wider problem. |
| 3. Write down the exact error. | Copy the visible message into the ticket. Take a screenshot with document contents, credentials and personal details removed. | Exact wording distinguishes sign-in, connection and application failures. |
| 4. Record the time. | Add the first reported failure and your test time to the ticket, with time zone. | These times let the next team find the matching logs. |
| 5. Check who is affected. | Ask the reporter which page failed and whether an authorized colleague has the same problem. If allowed, compare on another approved network. | One user, one office and all users suggest different causes. Do not use someone else's credentials. |
| 6. Check the app is running. | `Azure Portal > Container Apps > pdfval-api > Overview`; confirm resource group. Then `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`; open the active revision. | Check running status and ready replicas. Running alone does not prove sign-in, storage or PDF processing works. See Section 5.1. |
| 7. Check errors. | `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System`, then `Console`. Also `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`; follow Section 5.4. | Repeated 5xx errors, failed health checks or crashes explain real impact. If Application Insights is separately configured, follow Section 5.2. |
| 8. Check recent deployment. | [GitHub repository](https://github.com/ivanbueno/portal-pdf-validation) > `Actions > Deploy Azure > latest run > deploy`. In Azure: `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`. | Record the commit, start/end time, result and failed step. Success does not guarantee all user actions work. |
| 9. Check Azure service problems. | `Azure Portal > Service Health > Service issues`; select the affected subscription, region and services. Open a matching event. Some portal views call this page `Incidents`. | A matching Azure incident may explain the outage. Copy its tracking ID and impact. If the portal is unavailable, check [Azure status](https://azure.status.microsoft). |
| 10. Take a safe action or escalate. | Refresh once or retry sign-in once if no work is in progress. Add evidence to the ticket. Use the team's escalation route from Section 1. | Restart only with recorded approval and Section 6. Never change settings to experiment. |

Service Health can show affected services, resources and incident updates. No matching notice does not rule out an application problem. See [Microsoft's Service Health guide](https://learn.microsoft.com/en-us/azure/service-health/service-issues-blade).

## 4. Common Problems

The paths here apply to the deployed Container App. The detailed shared checks are in Section 5. Unless an approved change is explicitly recorded, all production investigation is read-only.

### Website is completely down

**What you may see:** The website does not open, shows a blank page, or fails for several users.

**What to check**

1. Confirm the URL, error, time and affected users using Section 3.
2. Check the active revision and both health URLs in Section 5.1.
3. Compare errors with deployments and Service Health.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`; `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream`.

**What good looks like:** A ready running revision, successful health checks and a usable page for an authorized user.

**What indicates a problem:** No ready copies, repeated server errors, or failed health checks.

**What you can safely do:** **Safe to do:** Refresh once without interrupting uploads; collect evidence.

**When to escalate:** **Escalate immediately** if multiple users cannot use the service. Tier 2 routes to DevOps and developers.

### Website is slow

**What you may see:** Pages take much longer than usual, requests time out, or PDFs stay queued.

**What to check**

1. Record which action is slow and how many seconds it takes. Separate page loading from waiting for a PDF result.
2. Compare response time, requests, CPU and memory using Sections 5.4 to 5.6.
3. For queued or running PDFs, check worker execution history and storage using Section 5.9.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`; `Azure Portal > Container App Jobs > pdfval-worker > Monitoring > Execution history`.

**What good looks like:** Page times resemble a healthy period; jobs make progress. Validation can take up to five minutes per standard, plus queue time.

**What indicates a problem:** Sustained latency increases, timeouts, failed workers or a growing queue with no processing progress.

**What you can safely do:** **Safe to do:** Ask affected users to avoid duplicate submissions. Record a small number of timed read-only checks.

**When to escalate:** **Escalate** persistent slowness to Tier 2. Escalate immediately when normal work is effectively blocked. No approved numerical latency target is recorded: **TBD: Confirm with application owner**.

### HTTP 500 error

**What you may see:** “Internal server error” or HTTP 500.

**What to check**

1. Record the page or action, time, and request ID if available.
2. Search request logs for status 500 and the same request ID using Section 7.
3. Compare the first error with the latest deployment.

**Where to go in Azure:** `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs`; conditional: `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures`.

**What good looks like:** The action completes without a server error.

**What indicates a problem:** The same action repeatedly fails, or errors increase across users.

**What you can safely do:** **Safe to do:** Retry a read-only page once. Do not replay an upload or submission without checking its current status.

**When to escalate:** **Escalate** recurring 500s to developers through Tier 2. Include request IDs and sanitized exception types.

### HTTP 502 or 503 error

**What you may see:** “Bad gateway,” “Service unavailable,” or “Storage unavailable.”

**What to check**

1. Check ready replicas and system logs for startup, health-check or image-download failures.
2. Compare `/health/live` with `/health/ready` using Section 5.1.
3. Check storage health, resource use and recent deployments.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System`; `Azure Portal > Storage accounts > [confirmed storage account] > Resource health`.

**What good looks like:** Ready replicas, successful health checks and no repeated gateway errors.

**What indicates a problem:** No healthy backend, storage failures, or repeated restarts. This app can return 503 directly when storage is unavailable.

**What you can safely do:** **Safe to do:** Retry a read-only page once and record the result. A restart requires Section 6 approval.

**When to escalate:** **Escalate** repeated failures to DevOps and developers. Widespread failures are urgent.

### HTTP 403 error

**What you may see:** “Forbidden,” missing role, same-origin request error, or a rejected direct upload.

**What to check**

1. Identify whether the error comes from sign-in, the portal API, or the storage upload host. Do not copy the upload URL's query string.
2. Check the user's work account and the exact error. Staff normally need `Validation.User`; integrations use `Validation.Run`, or an approved delegated `Validation.Access` scope.
3. Ask Tier 2 to inspect role assignments and sign-in failures. Browser uploads may also fail because their temporary grant expired or the allowed website origin is wrong.

**Where to go in Azure:** `Azure Portal > Microsoft Entra ID > Enterprise applications > [confirmed portal enterprise application] > Users and groups`; `Azure Portal > Microsoft Entra ID > Monitoring & health > Sign-in logs`.

**What good looks like:** An authorized account can access its own documents and upload from the approved website.

**What indicates a problem:** A previously authorized user is denied, many users lose access, or storage uploads suddenly fail.

**What you can safely do:** **Safe to do:** Retry sign-in once in a private window. **Use caution:** Never assign roles, change storage permissions or bypass sign-in.

**When to escalate:** **Escalate** unresolved access failures to the identity/security team through Tier 2. Route storage upload failures to DevOps and developers.

### HTTP 404 error

**What you may see:** “Not found,” a missing report, or a broken page link.

**What to check**

1. Open the production homepage, then use its own navigation.
2. Check that the affected user owns the document and that it has not expired or been deleted.
3. Check whether failures began after a deployment. A missing, expired, deleted or another user's document intentionally returns the same 404.

**Where to go in Azure:** `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs`; `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`.

**What good looks like:** Current navigation and the user's unexpired documents work.

**What indicates a problem:** Current links fail for valid, owned, unexpired documents, or many assets/pages are missing.

**What you can safely do:** **Safe to do:** Correct a mistyped URL or navigate from the homepage. Explain the 72-hour retention rule.

**When to escalate:** **Escalate** broken current links to developers. Missing unexpired data follows the data-loss procedure in Section 12.

### Login does not work

**What you may see:** A sign-in loop, HTTP 401, an Entra error code, or a sign-in page that never completes.

**What to check**

1. Record the visible sign-in error code, timestamp, correlation ID and affected users. Never collect credentials.
2. Try a private window once with the user's own authorized work account.
3. Check sign-in logs and recent authentication changes. The expected callback is the production URL followed by `/.auth/login/aad/callback`.

**Where to go in Azure:** `Azure Portal > Microsoft Entra ID > Monitoring & health > Sign-in logs`; `Azure Portal > Container Apps > pdfval-api > Settings > Authentication`; `Azure Portal > Microsoft Entra ID > App registrations > [confirmed portal registration] > Authentication`.

**What good looks like:** Sign-in completes and the user can view their workspace. A 401 before signing in is expected.

**What indicates a problem:** Authorized users repeatedly fail, callback errors appear, or sign-in reports an expired client credential.

**What you can safely do:** **Safe to do:** Retry sign-in once. Read status and error codes. Do not reveal secrets or change MFA, callback URLs or authentication settings.

**When to escalate:** **Escalate** persistent failures to the identity/security team and DevOps. All-user login failure is urgent.

### Some pages work and others do not

**What you may see:** The homepage loads but document lists, uploads, PDF viewing or reports fail.

**What to check**

1. List one working and one failing action, with times and HTTP codes.
2. Check sign-in, document ownership and expiration. A public homepage loading does not prove protected APIs work.
3. Check request logs, readiness and the worker's execution history.

**Where to go in Azure:** `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs`; `Azure Portal > Container App Jobs > pdfval-worker > Monitoring > Execution history`.

**What good looks like:** Authorized users can load current documents and completed reports. A report may be unavailable while processing is unfinished.

**What indicates a problem:** One action consistently fails for valid input or a required job stops completing.

**What you can safely do:** **Safe to do:** Retry the affected read-only page once; record its request ID.

**When to escalate:** **Escalate** repeatable route or report failures to developers; failed jobs or storage access to DevOps.

### Database connection error

**What you may see:** Missing document lists, storage errors, or failed readiness. A user may describe this as a database error.

**What to check**

1. Treat Azure Table, Blob and Queue Storage as the data dependencies here. There is no SQL database in the reviewed deployment.
2. Check readiness and `storage_unavailable` events.
3. Check the confirmed storage account's health, metrics and recent changes using Section 5.9.

**Where to go in Azure:** `Azure Portal > Storage accounts > [confirmed storage account] > Resource health`; `Azure Portal > Storage accounts > [confirmed storage account] > Monitoring > Metrics`; `Azure Portal > Storage accounts > [confirmed storage account] > Activity log`.

**What good looks like:** Readiness succeeds and document data is available to its owner.

**What indicates a problem:** Timeouts, denied storage access, a service issue, or multiple data operations failing.

**What you can safely do:** **Safe to check:** Record error types and times. Storage access uses an Azure-managed application identity; do not invent or replace a connection string.

**When to escalate:** **Escalate** to DevOps/storage owner. Contact the database team only if the owner confirms an additional database dependency.

### API error

**What you may see:** Upload, submit, polling or report requests fail in the portal or an integration.

**What to check**

1. Capture the request method, URL path without query strings, HTTP code, time and `X-Request-ID` response header when available.
2. Compare the error with [API documentation](api.md): 401/403 access, 404 ownership/expiration, 409 state/conflict, 413 size, 422 invalid input, 500/503 service failure.
3. For direct uploads, identify storage as the failing host. For stuck processing, check worker history.

**Where to go in Azure:** `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs`; `Azure Portal > Container App Jobs > pdfval-worker > Monitoring > Execution history`.

**What good looks like:** Requests return the documented success code and the document moves through its expected states.

**What indicates a problem:** Valid requests repeatedly fail, processing returns `error`, or the queue does not progress.

**What you can safely do:** **Safe to do:** Correct user input using the published guide. Do not blindly replay writes. API integrations must follow their documented retry/idempotency rules, which prevent duplicate submissions.

**When to escalate:** **Escalate** repeatable valid-request failures to developers with sanitized request metadata.

### DNS problem

**What you may see:** “Server not found,” “DNS address could not be found,” or a hostname that works on one approved network but not another.

**What to check**

1. Compare the typed hostname with the production URL and the app's Application URL.
2. Try the confirmed hostname from another approved device/network, if policy permits.
3. If a custom domain is reported, check its recorded binding and ask the network team to inspect DNS, the service that maps website names to addresses.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Overview > Application URL`; if applicable, `Azure Portal > Container Apps > pdfval-api > Settings > Custom domains`.

**What good looks like:** The correct hostname resolves and reaches the expected site.

**What indicates a problem:** Name-resolution errors or different results between networks. Do not assume DNS is hosted in Azure.

**What you can safely do:** **Safe to do:** Correct typing and record the hostname and affected network. Do not change DNS, local hosts files or network controls.

**When to escalate:** **Escalate** to the network team and DevOps. Broad production hostname failure is urgent.

### Certificate problem

**What you may see:** “Your connection is not private,” expired certificate, or certificate name mismatch.

**What to check**

1. Record the warning and hostname. Check the device's date and time.
2. Use the browser's connection information to inspect the certificate name and expiry without continuing through the warning.
3. For a confirmed custom domain, inspect its certificate binding. For the default Azure hostname, route to DevOps for platform investigation.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Settings > Custom domains`; `Azure Portal > Service Health > Service issues`.

**What good looks like:** HTTPS opens without warnings and the certificate covers the hostname and current date.

**What indicates a problem:** Expiry, wrong name, or an untrusted issuer.

**What you can safely do:** **Safe to check:** Collect certificate metadata. Do not bypass the warning, install a certificate or disable HTTPS checks.

**When to escalate:** **Escalate** to DevOps/network. Unexpected certificates or suspected interception also go to security immediately.

### Problem started after a deployment

**What you may see:** Errors, broken pages or changed behavior begin shortly after a release.

**What to check**

1. Record the last known good time and first failure time.
2. Open the GitHub workflow run; record commit, result and failed step, if any.
3. Compare the serving revision's image tag and Azure change times. The newest attempted revision may not be the one serving users.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`; `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`; `Azure Portal > Resource groups > pdf-validation-prod > Activity log`.

**What good looks like:** The intended revision serves traffic and affected user actions work.

**What indicates a problem:** Failure starts near a code/configuration change, a new revision fails, or different components run unexpected image tags.

**What you can safely do:** **Safe to check:** Gather release and error evidence. Time correlation is a clue, not proof of cause.

**When to escalate:** **Escalate** to DevOps and developers. Do not rerun, redeploy, change traffic or roll back without authorization.

### Application keeps restarting

**What you may see:** Intermittent errors, repeated startup messages, or an increasing restart count.

**What to check**

1. Check Total Replica Restart Count and split by replica/revision.
2. Read system logs for crashes, health-check failures and out-of-memory messages.
3. Compare CPU, memory and deployment times. A worker job finishing is normal and is not an API restart.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`; `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System`.

**What good looks like:** Stable API replicas without repeated restarts outside expected release activity.

**What indicates a problem:** The same replica repeatedly crashes, loses readiness or runs out of memory.

**What you can safely do:** **Safe to check:** Capture restart times and preceding errors. Do not manually restart a crash loop.

**When to escalate:** **Escalate** to DevOps and developers immediately if availability is affected.

### High CPU

**What you may see:** Slow requests while processor use stays unusually high.

**What to check**

1. Follow Section 5.5 to read CPU per replica and its units.
2. Compare against a healthy period, request volume and the replica's configured CPU limit.
3. Distinguish API usage from PDF worker usage; validation jobs legitimately use CPU.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`; `Azure Portal > Container Apps > pdfval-api > Application > Containers > api`.

**What good looks like:** Usage returns toward baseline after busy periods and users can work.

**What indicates a problem:** Sustained use close to the configured limit with latency or errors.

**What you can safely do:** **Safe to do:** Avoid repeated tests or duplicate submissions and collect charts.

**When to escalate:** **Escalate** sustained saturation with impact to DevOps/developers. Do not scale or kill processes.

### High memory use

**What you may see:** Increasing memory, crashes, or out-of-memory errors.

**What to check**

1. Follow Section 5.5 and compare per-replica memory against its configured limit.
2. Check whether memory drops after normal work or keeps rising.
3. Match system-log failures with restart counts and recent releases.

**Where to go in Azure:** `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`; `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System`.

**What good looks like:** Stable memory with room below the limit and no memory-related terminations.

**What indicates a problem:** Memory approaches the limit repeatedly, continues growing, or logs report `OOM`/out of memory. An exit code alone is not proof of the cause.

**What you can safely do:** **Safe to check:** Capture charts, limits, affected replica and errors. Do not clear data or change memory limits.

**When to escalate:** **Escalate** to developers and DevOps, urgently if requests or jobs are failing.

## 5. Common Azure Checks

### 5.1 Check if the Container App is running

**Safe to check. For this production Container App:**

1. Go to `Azure Portal > Container Apps > pdfval-api > Overview`.
2. Confirm resource group `pdf-validation-prod`, subscription and Application URL. If they do not match Section 1, stop and ask Tier 2 to identify the resource.
3. Go to `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`. Some views label this `Revisions and replica` or `Revision management`.
4. Select the active revision serving traffic. Record its name, running/health status, ready replica count and image tag. Expected template configuration is one active revision and 1 to 3 API replicas.
5. Open [liveness](https://pdfval-api.calmocean-f7286a46.westus2.azurecontainerapps.io/health/live) in a browser tab. Expected: `{"status":"ok"}`.
6. Open [readiness](https://pdfval-api.calmocean-f7286a46.westus2.azurecontainerapps.io/health/ready). Expected: `{"status":"ready"}`. Record errors and times; do not repeatedly refresh.

Liveness proves the application process answers. Readiness also checks access to Blob, Queue and Table Storage. Neither proves sign-in, browser uploads or PDF validation works. Confirm the originally reported action separately. “Running” describes execution, not full service health. Failed or degraded revisions require logs and escalation. See [Microsoft's startup troubleshooting guide](https://learn.microsoft.com/en-us/azure/container-apps/troubleshoot-container-start-failures).

### 5.2 Check Application Insights

**Safe to check, only if separately configured.** This repository does not create Application Insights. Do not enable it during an incident. If absent, write “Not configured in reviewed deployment” and use Section 7's Log Analytics queries.

1. Go to `Azure Portal > Application Insights > [owner-confirmed resource] > Investigate > Failures`.
2. Set the incident time range. Select the server view if a Server/Browser selector appears.
3. Open the failing operation, response code or exception, then a sample and its transaction details.
4. Record time, operation, error type, result code and operation ID. Inspect related dependency failures without copying sensitive payloads.
5. For exception details, use `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures > Exceptions`.

Good means relevant requests are present and failures are not elevated. Empty data may mean wrong resource, time range, missing instrumentation, ingestion delay or access limits. It does not prove there are no errors. See [Microsoft's failure investigation guide](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/proactive-failure-diagnostics).

### 5.3 Check Log Stream

**Safe to check.**

1. Go to `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream`.
2. Select **System** for platform events, such as startup and health-check failures.
3. Select **Console** for application messages. Choose the serving revision, replica and container `api` when selectors appear.
4. Observe while reproducing a safe read-only action once. Record the timestamp and short relevant messages.
5. If no messages appear, check the selected replica. Use saved logs in Section 7 for earlier events; an idle stream is not proof of health.

Do not enable additional logging or use a command console. If logging is unavailable, record that and escalate to DevOps. See Microsoft's [Container Apps log stream guide](https://learn.microsoft.com/en-us/azure/container-apps/log-streaming).

### 5.4 Check HTTP errors

**Safe to check.** A 4xx code usually means a rejected or invalid request. A 5xx code means the service could not complete it.

1. Go to `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`.
2. Set the incident time range. Select **Requests**, aggregation **Sum**.
3. Choose **Apply splitting > Status Code Category**. Inspect 4xx and 5xx. Split by **Status Code** for individual codes.
4. Compare error counts with total requests and the period before the incident. Record chart time zone, filters and affected revision.
5. Use Section 7's request query to match errors to request IDs. Requests blocked before reaching the app may have no application log entry.

Routine unauthenticated 401s or expired-document 404s can be expected. A sudden rise affecting valid user actions needs investigation. There is no approved error-rate threshold recorded: **TBD: Confirm with application owner**.

### 5.5 Check CPU and memory

**Safe to check.**

1. Go to `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`.
2. Chart **CPU Usage** and **Memory Working Set Bytes** separately. Use the incident range and compare with an earlier healthy period.
3. Use **Apply splitting > Replica** and filter the serving revision. Inspect average and maximum where offered; an average can hide one overloaded copy.
4. Compare with configured limits at `Azure Portal > Container Apps > pdfval-api > Application > Containers > api`. Read only.
5. Capture units, limits, peak/time, replica and the related symptom. CPU measured in nanocores is not a percentage. One CPU core equals 1,000,000,000 nanocores.

Repository defaults are **0.5 CPU / 1 GiB per API replica**, **2 CPU / 4 GiB per worker execution**, and **0.5 CPU / 1 GiB for maintenance**. Compare each component to its own limit. Do not compare a total across replicas to one replica's limit. Sustained near-limit use with errors, latency or memory terminations needs escalation; brief processing spikes alone do not prove an incident. Approved thresholds: **TBD: Confirm with application owner**.

### 5.6 Check response time

**Safe to check.**

1. Go to `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`.
2. If available, select **Average Response Time (Preview)**. Compare the incident with a healthy period using the same units and filters.
3. If unavailable or empty, go to `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs` and run the response-time query in Section 7.
4. Record a timed browser check of the affected action. Application request times do not include all browser/network delay or the time a PDF waits for a worker.

The Metrics choices in Sections 5.4 to 5.6 follow the [Container Apps metrics reference](https://learn.microsoft.com/en-us/azure/container-apps/metrics). Preview metrics may not be available in every deployment.

**Conditional Application Insights:** `Azure Portal > Application Insights > [confirmed resource] > Investigate > Performance > Operations`; select the incident window and affected operation. Check slow samples and dependencies. Compare like-for-like periods, not an invented universal target.

### 5.7 Check recent deployments

**Safe to check.**

1. Open [Deploy Azure](https://github.com/ivanbueno/portal-pdf-validation/actions/workflows/deploy.yml). Select the latest run, then **Summary**. Record status, commit and start/end times.
2. Select **deploy**, then inspect the failing step or **Deploy application**. The workflow's summary reports the portal URL; its final readiness check should succeed.
3. Go to `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`. Open `portal` or `foundation`, inspect status/time and **Operation details** for failures. Reused deployment names are not a complete release history; use GitHub for older runs.
4. Go to `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`; open the serving revision and record its image tag. Images are tagged with the Git commit ID.
5. If needed, inspect job image details at `Azure Portal > Container App Jobs > pdfval-worker > Settings > Containers` and the same path for `pdfval-maintenance`.

A failed workflow can leave partial changes. A successful workflow checks readiness but does not prove sign-in or end-to-end validation. Do not click Run workflow, Re-run jobs, Redeploy, activate/deactivate a revision, or alter traffic.

### 5.8 Check recent Azure changes

**Safe to check.**

1. Go to `Azure Portal > Resource groups > pdf-validation-prod > Activity log`.
2. Set the incident range, starting before the first failure; select **Apply** if shown. Include all statuses.
3. Open changes affecting the app, environment, storage, identity or jobs.
4. Record operation name, resource, caller, status, time and correlation ID. If **Change history** is offered, inspect property names without copying secret values.

Activity Log records management changes, not every request, background restart, data operation or Entra event. Missing records do not prove no change occurred. See [Microsoft's Activity Log guide](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/activity-log).

### 5.9 Check dependencies

**Safe to check.** A dependency is another service the application needs.

1. Go to `Azure Portal > Resource groups > pdf-validation-prod > Overview`. Find the Storage account, jobs and Container Apps environment by resource type. Confirm the storage account with the owner before using its data pages.
2. Go to `Azure Portal > Storage accounts > [confirmed storage account] > Resource health`. Then `Azure Portal > Storage accounts > [confirmed storage account] > Monitoring > Metrics`; select the Blob, Queue or Table service metric namespace as relevant. Inspect **Availability**, **Transactions** by **Response type**, and **Success E2E Latency** for the incident window where available.
3. Go to `Azure Portal > Container App Jobs > pdfval-worker > Monitoring > Execution history`. Select a failed or delayed execution and **View logs** if offered. Repeat for `pdfval-maintenance`. Recent successful work and maintenance are expected; an idle worker is normal when no documents are queued.
4. Check existing alerts at `Azure Portal > Monitor > Alerts`; filter resource group `pdf-validation-prod` and the incident range. Template alerts cover processing/maintenance errors, failed jobs and backlog. No alert email does not prove health; recipients are optional.
5. For login, go to `Azure Portal > Microsoft Entra ID > Monitoring & health > Sign-in logs`; filter the confirmed portal application and incident time. A permitted identity administrator may need to collect this evidence.
6. If Application Insights was added separately, go to `Azure Portal > Application Insights > [confirmed resource] > Investigate > Performance > Dependencies`. Select a slow/failed dependency and a sample to identify the affected service. See [Microsoft's dependency investigation guide](https://learn.microsoft.com/en-us/azure/azure-monitor/app/dependencies).

The worker normally allows up to four concurrent executions. Maintenance is scheduled every two minutes. The configured queue alert uses an hourly average above 1,000 messages, so it can miss a smaller or recent backlog. Do not wait for it before reporting stalled processing. Do not peek at PDF contents, edit tables, dequeue/purge messages or manually start jobs.

Job history has a limited recent window; use saved logs for older events. See [Microsoft's job execution history guide](https://learn.microsoft.com/en-us/azure/container-apps/jobs).

## 6. Restarting the Container App

**Use caution. A restart interrupts requests and can remove useful live evidence. It does not repair a code defect, broken permissions, DNS or a failed dependency.**

A restart may be appropriate when the process is unresponsive, evidence has been collected, dependencies appear available, and the authorized incident lead or DevOps approver specifically approves one restart. The approval must identify the resource, serving revision, operator, time and observation window. Restart approver and standard window: **TBD: Confirm with application owner**. If these are unknown, escalate instead.

Do not restart during a suspected security incident or data-loss investigation, a deployment already in progress, an existing crash loop, a known storage/Azure outage, or an unresolved authentication/DNS/certificate failure. Do not restart simply because a PDF reports failed validation. Do not restart worker or maintenance jobs under an API restart approval.

### Before restarting

Record in the restricted support ticket:

- Current errors and affected actions/users.
- First failure time and time zone.
- Application status, serving revision and ready replicas.
- Important console/system log messages and request IDs.
- Current CPU, memory, limits and charts.
- Latest deployment commit, result and time; recent Azure changes.
- Dependency status, approval reference and expected customer impact.

### Approved Container App restart

1. Confirm approval and target `pdfval-api` in `pdf-validation-prod`.
2. Go to `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas`.
3. Select the **active revision currently serving traffic**. Recheck its name against the ticket.
4. Use that revision's **Restart** action, which may appear in its `...` menu, and confirm the prompt once. If Restart is absent or the target is unclear, stop and have DevOps perform the approved revision restart. Do not use Deactivate, Stop, Delete, or Create new revision as substitutes.
5. Record the action time. Refresh revision status during the approved observation window.

Azure supports restarting a specific revision; see [Microsoft's revision management reference](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage). Portal labels vary, so the absence of this action is a handoff to DevOps, not permission to try another control.

### Verify recovery

For this portal, check ready replicas, both health URLs, the originally failing action, new 5xx errors and new restart events. Use your own authorized account to verify sign-in and a read-only document/report operation. If upload/validation was affected, use an owner-approved non-sensitive test file only when test submission is authorized. Health checks alone are not enough to close the ticket. Record whether the reporter can work again and watch for recurrence through the agreed observation window.

**Do not repeatedly restart the application. If one approved restart does not fix the problem, collect the information and escalate.**

## 7. Logs

**Safe to check. Use a restricted support ticket.** Never copy passwords, API keys, tokens, cookies, authorization headers, connection strings, client secrets or temporary upload URLs. A storage upload URL contains a temporary credential in its query string. Remove query strings from URLs. Review screenshots and logs for document contents, filenames and personal information. Do not attach full browser network captures or raw deployment logs to a general ticket.

| Source | What it tells you | Where to find it | What to look for | What to copy into the ticket |
|---|---|---|---|---|
| Application Insights, conditional | Recorded request and dependency behavior, if connected. | `Azure Portal > Application Insights > [confirmed resource] > Overview` | Correct resource and fresh data. | Resource name, selected time range, whether telemetry exists. |
| Failures, conditional | Failed operations and response codes. | `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures` | Error increases at the incident time. | Operation name, code, count, time and operation ID. |
| Exceptions, conditional | Recorded application exceptions. | `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures > Exceptions` | Repeating exception types and failing components. | Sanitized type, brief message, sample time and operation ID. |
| Log Stream | Live application messages and Azure platform events. | `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > Console` or `System` | Crashes, readiness failures, denied access and repeated errors. | Short sanitized excerpt, timestamp, revision, replica and stream type. |
| Saved logs | Earlier API, worker and maintenance events. | `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs` | `storage_unavailable`, `validation_infrastructure_error`, request 5xx, or `maintenance_finished` with failures above zero. | Event, time, request/document ID if permitted, revision/job and error type. |
| Metrics | Counts and trends, not exception details. | `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics` | Errors, resource pressure, latency or restarts near the failure. | Sanitized chart with range, units, filters and aggregation. |
| Activity Log | Resource management changes. | `Azure Portal > Resource groups > pdf-validation-prod > Activity log` | Writes, role/configuration changes, restart actions and failed operations. | Operation, resource, time, caller, status and correlation ID. |
| Deployment logs | Release steps and results. | `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments > [deployment] > Operation details`; GitHub `Actions > Deploy Azure > [run] > deploy` | Failed provisioning, image build/start, or readiness steps. | Run link, commit, result, times, failed step and sanitized error. |
| Job history | Whether background processing executed. | `Azure Portal > Container App Jobs > [pdfval-worker or pdfval-maintenance] > Monitoring > Execution history > [execution]` | Failed executions, long-running work, or missed progress. | Job/execution name, state, start/end times and relevant log event. |

### Search saved logs

1. Go to `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs`.
2. If a query gallery opens, close it. Select the query editor or **KQL mode** if the page starts in a simple mode. KQL is Azure's log search language.
3. Paste one query below and select **Run**. These only read logs.
4. Each query below covers the last hour. For an older incident, replace the time filter with `TimeGenerated between (datetime(2026-09-28T18:45:00Z) .. datetime(2026-09-28T19:15:00Z))`, using the actual incident's UTC times, and set the portal time picker to include them.
5. If a table is missing, data is empty or access is denied, record the exact problem and ask DevOps. Do not create diagnostic settings to fill the gap during an incident.

Recent API errors, with only selected fields:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where ContainerAppName_s == "pdfval-api"
| extend e = parse_json(Log_s)
| where (tostring(e.event) == "request" and toint(e.status) >= 400)
    or tostring(e.event) == "storage_unavailable"
| project TimeGenerated, RevisionName_s, event=tostring(e.event),
    status=toint(e.status), request_id=tostring(e.request_id),
    error_type=coalesce(tostring(e.error), tostring(e.type))
| order by TimeGenerated desc
| take 100
```

Application response-time trend:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where ContainerAppName_s == "pdfval-api"
| extend e = parse_json(Log_s)
| where tostring(e.event) == "request"
| summarize requests=count(), errors5xx=countif(toint(e.status) >= 500),
    average_ms=avg(todouble(e.duration_ms)),
    p95_ms=percentile(todouble(e.duration_ms), 95) by bin(TimeGenerated, 5m)
| order by TimeGenerated asc
```

`p95_ms` is the time at or below which 95% of recorded requests completed. This app's logs omit URL paths and include health checks, so the chart is an overall clue. Use the browser's request ID to investigate a specific failing action; absence of application logs does not exclude an upstream failure.

Worker and maintenance errors across the application workspace:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| extend e = parse_json(Log_s)
| where tostring(e.event) in ("validation_infrastructure_error", "invalid_queue_message")
    or (tostring(e.event) == "maintenance_finished" and toint(e.failures) > 0)
| project TimeGenerated, event=tostring(e.event),
    document_id=tostring(e.document_id), failures=toint(e.failures)
| order by TimeGenerated desc
| take 100
```

The deployment sends logs to Log Analytics with 30-day retention. These queries match the repository's structured event fields and configured `ContainerAppConsoleLogs_CL` table. They have not been executed against the live workspace. For platform events, also inspect `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System`; a process killed by Azure may not write its own error event. See [Microsoft's saved-log guide](https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring).

To collect an API request ID without secrets, open the browser's developer tools, select **Network**, reproduce a safe read once, choose that request, then inspect **Headers > Response Headers > X-Request-ID**. Copy only that ID, the status code and URL path without query strings. Do not copy request headers, cookies or upload grants.

## 8. Recent Changes

**Safe to check.** Build a short timeline before deciding a change caused the incident.

| Change | Where to check | Record |
|---|---|---|
| New deployment | GitHub `Actions > Deploy Azure > [run]`; `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments` | Start/end time, commit, result and current serving revision. |
| Application configuration | `Azure Portal > Container Apps > pdfval-api > Activity log`; read current names at `Azure Portal > Container Apps > pdfval-api > Application > Containers > api > Environment variables` | Time, caller, operation and changed property names. Do not copy values. |
| Explicit restart or resource update | `Azure Portal > Container Apps > pdfval-api > Activity log` | Operation, time, caller and outcome. |
| Automatic crash/restart | `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics > Total Replica Restart Count`; `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream > System` | Replica, time, surrounding error and whether a deployment was underway. |
| Storage or identity permissions | `Azure Portal > Resource groups > pdf-validation-prod > Activity log`; `Azure Portal > Storage accounts > [confirmed storage account] > Activity log` | Resource, operation, caller and correlation ID. |
| Entra/sign-in change | `Azure Portal > Microsoft Entra ID > Monitoring & health > Audit logs`; `Azure Portal > Microsoft Entra ID > Monitoring & health > Sign-in logs` | Application, change/error, timestamp and correlation ID. Identity team may need to supply these. |
| Other connected service | `Azure Portal > Resource groups > pdf-validation-prod > Overview > [confirmed dependency] > Activity log`; external service's owner-approved change record | Service, maintenance/change time and observed effect. |

1. Write the last successful use and first failed use in UTC.
2. Place deployment, configuration, sign-in and restart events on that same timeline.
3. Look for changes just before the first failure, and check whether unaffected users/actions contradict the theory.
4. Give Tier 2 the timeline and evidence. Do not undo a change based only on timing.

## 9. Quick Error Guide

| Problem | What It May Mean | First Thing to Check | What To Do |
|---|---|---|---|
| Website will not load | Browser/network issue or unavailable app. | Correct URL, affected users, ready replicas. | Follow Section 3; escalate broad outage immediately. |
| 500 error | Application failed to process a request. | Request ID and application logs. | Retry a read once; send recurring failures to developers. |
| 502 error | Gateway could not obtain a valid app response. | Revision health and system logs. | Escalate repeated failures to DevOps. |
| 503 error | App unavailable or storage failure. | Liveness versus readiness; storage health. | Escalate; do not repeatedly restart. |
| 403 error | Permission, origin or upload-grant failure. | Failing host, account and exact message. | Retry sign-in once; send access changes to the responsible team. |
| 404 error | Bad URL or unavailable/expired/not-owned document. | URL, ownership and age. | Navigate from homepage; escalate missing unexpired data. |
| Slow website | Resource pressure, dependency delay or queue wait. | Request times, CPU/memory, worker progress. | Avoid duplicate submissions; collect metrics and escalate. |
| Login failure | Session, Entra role, policy or credential issue. | Sign-in error and Entra logs. | Private window once; escalate persistent/all-user failure. |
| Database error | This app normally means Storage access failed. | Readiness and storage errors. | Contact DevOps/storage owner; database team only if applicable. |
| API error | Invalid input/access, conflicting state or service error. | HTTP code, request ID and documented API behavior. | Correct input or escalate; do not blindly replay writes. |

## 10. Escalation

**Tier 1 to Tier 2:** Escalate immediately for a broad outage, possible security incident or possible data loss. Also escalate when a safe retry fails, the cause remains unclear after the initial checks, required logs are inaccessible, or resolution would need a production change. Do not delay escalation to complete every ticket field.

**Tier 2:** Identify the likely failing component and engage the team below. Coordinate cross-team incidents through the approved incident lead. Team contacts, paging method, severity definitions and response-time targets are **TBD: Confirm with application owner**. Until recorded, use the organization's existing service desk/on-call process; do not invent a contact.

| Problem | Who To Contact | Information To Provide |
|---|---|---|
| Repeatable 500, broken page, report or API defect | Application developers | Failing action, sanitized request IDs/error types, commit, example time and reproducibility. |
| Failed revision/deployment, unhealthy replicas, high CPU/memory, restarts, failed jobs | DevOps | Resource group/app/revision, image tag, metrics, system logs, job execution and deployment link. |
| Table/Blob/Queue errors or stalled storage access | DevOps or storage owner | Storage resource, affected operation/service, readiness result, error type, incident time and health status. |
| Confirmed additional database failure | Database team | Confirmed database/service name, failure time, sanitized connection error, affected operations. Never credentials. |
| DNS, routing, network-specific failure or certificate binding issue | Network team with DevOps | Hostname, affected networks, exact browser error, certificate metadata and comparison results. |
| Sign-in/role/policy failure | Identity/security team with DevOps | Application name, authorized user identifier via restricted channel, Entra error/correlation ID and time. |
| Suspected unauthorized access, leaked secret or unexpected content | Security team immediately | Observation time, affected resource, sanitized evidence and incident link. Do not investigate other users' data. |
| Missing unexpired data or unexpected deletion | Incident lead, DevOps/storage owner and developers immediately | Document ID if permitted, owner, expected retention, last seen/first missing, deletion/change evidence. |
| Matching Azure outage or unexplained platform failure after app/dependency checks | DevOps opens Microsoft Azure support case | Subscription/resource IDs, region, UTC timeline, Service Health tracking ID, sanitized logs and steps tried. |

For an authorized Azure support contact: `Azure Portal > Help + support > Create a support request`; select the affected subscription/service and follow the support plan's incident process. Support plan and authorized case opener: **TBD: Confirm with application owner**. Tier 1 should route internally first.

## 11. Information to Collect

Copy this template into the restricted incident ticket. Use “Unknown” or “Not available” instead of guessing. Remove secrets and personal/document content before attaching evidence.

```text
Application: PDF Validation Portal
Environment: Production
Website URL (no query string):
Azure subscription / directory (if known):
Resource group: pdf-validation-prod
App / serving revision / replica:
Incident severity / business impact:

Reported by (approved internal identifier):
First known failure, including time zone:
Last known successful use, including time zone:
My reproduction time, including time zone:
Number / scope of affected users:
Affected location / approved network / browser:
Working action or page:
Failing action or page:
Exact error message (sanitized):
HTTP code / request method / URL path without query:
X-Request-ID / Entra correlation ID, if available:
Sanitized screenshot attachment:

App running status / ready replicas:
/health/live result and time:
/health/ready result and time:
Important application/system log messages (sanitized):
Application Insights resource/errors, or not configured/not accessible:
CPU value, unit, replica, limit and time range:
Memory value, unit, replica, limit and time range:
Response time / 4xx / 5xx trend and time range:
Restart count / relevant restart times:
Worker / maintenance execution IDs and status:
Storage / other dependency status:
Azure Service Health issue / tracking ID:

Most recent deployment run link:
Deployment commit / result / start and end times:
Recent Azure or Entra changes / caller / time:
Steps already tried, with times:
Result of each step:
Restart approval reference / approver, if any:
Restart resource / revision / time / result, if any:
Evidence unavailable or checks not completed:
Escalated to / time / incident owner:
Next agreed update time:
```

## 12. Emergency Problems

**Escalate immediately. Start the organization's incident process while collecting essential evidence. Do not wait for all checks to finish.**

| Emergency | First actions | Stop and escalate to |
|---|---|---|
| Entire website is down | Record URL, time and error; confirm another user if quickly possible. Check `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas` and `Azure Portal > Service Health > Service issues`. | Tier 2, incident lead and DevOps immediately. No unapproved restart or deployment. |
| Website is extremely slow | Record business impact and one timed action. Check `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics`. Ask users to avoid duplicate submissions. | Tier 2, DevOps and developers when normal work is effectively blocked. No load tests or scaling. |
| Database/data service unavailable | Check readiness and `Azure Portal > Storage accounts > [confirmed storage account] > Resource health`. This deployment uses Storage. | DevOps/storage owner immediately; database team if a database is confirmed. No data edits or credential changes. |
| Login unavailable for all users | Record Entra error/correlation ID and time. Check `Azure Portal > Microsoft Entra ID > Monitoring & health > Sign-in logs` if permitted. | Identity/security team and DevOps immediately. Do not disable authentication or MFA. |
| Azure has an outage | Open `Azure Portal > Service Health > Service issues > [matching issue]`. Record tracking ID, affected region/services and last update. | Incident lead and DevOps; authorized owner engages Azure support. Follow approved communications and recovery decisions. |
| Possible security incident | Stop reproducing suspicious behavior and stop production changes. Preserve minimal sanitized evidence in the restricted incident channel. | Security team immediately. Do not restart, delete logs, rotate secrets or explore exposed data unless directed by the incident responder. |
| Possible data loss | Check document age and known user deletion. If it is unexpectedly missing before 72 hours, record IDs, times and scope without recreating or overwriting it. | Incident lead, DevOps/storage owner and developers immediately. Do not restore, purge queues, modify tables, or promise recovery. |

The repository does not configure storage backups, versioning or soft delete. Files are intentionally short-lived. The recovery capability actually enabled in Azure is **TBD: Confirm with application owner**. This makes early escalation for unexpected loss important. A 404 alone does not distinguish expiration, deletion and ownership restrictions.

## 13. Things Support Should NOT Do

**Warning: Unless specifically authorized for the incident, support must not:**

- Delete Azure resources, revisions, storage data or logs.
- Change production networking, ingress, firewall rules or DNS.
- Change connection strings, passwords, secrets or certificate bindings.
- Change authentication, role assignments, consent, MFA or access policies.
- Modify a production database or this app's Table/Blob/Queue data.
- Purge/dequeue messages, replay jobs, manually start jobs or change retention.
- Scale CPU, memory, replica counts or worker concurrency.
- Deploy code, rerun the deployment workflow or roll back a release.
- Activate/deactivate revisions, change traffic routing or create a new revision.
- Change production application settings or enable new diagnostic collection.
- Bypass HTTPS warnings, expose private files, or share credentials and upload links.
- Repeatedly restart the application.

When unsure, collect information and escalate. Reading a Microsoft troubleshooting page that recommends a configuration change does not authorize support to make that change.

## 14. Quick Reference

### Website Down: one-page checklist

**Production:** [PDF Validation Portal](https://pdfval-api.calmocean-f7286a46.westus2.azurecontainerapps.io) · `pdf-validation-prod` · Container App `pdfval-api`.

**Broad outage, security concern or unexpected data loss: escalate immediately.** Contacts: **TBD: Confirm with application owner**; use the existing service desk/on-call process.

1. Confirm the website is down. Try the exact URL once; check affected users.
2. Record the error and time. Include time zone, HTTP code and sanitized screenshot.
3. Check the app status and serving revision. Test `/health/live` and `/health/ready`.
4. Check Application Insights **only if configured**; otherwise use `pdfval-logs`.
5. Check 5xx errors and whether valid user requests fail.
6. Check Log Stream: System for platform failures, Console for app errors.
7. Check recent deployments. Record GitHub run, result and commit.
8. Check recent Azure changes. Match times with the first reported failure.
9. Check dependent services: Storage, Entra sign-in, worker and maintenance jobs.
10. Perform an approved safe action or escalate with Section 11's ticket template.

| Check | Most-used path |
|---|---|
| Status and URL | `Azure Portal > Container Apps > pdfval-api > Overview` |
| Serving version | `Azure Portal > Container Apps > pdfval-api > Application > Revisions and replicas` |
| Live errors | `Azure Portal > Container Apps > pdfval-api > Monitoring > Log stream` |
| HTTP errors, CPU, memory | `Azure Portal > Container Apps > pdfval-api > Monitoring > Metrics` |
| Saved errors | `Azure Portal > Log Analytics workspaces > pdfval-logs > Logs` |
| Application Insights, if added | `Azure Portal > Application Insights > [confirmed resource] > Investigate > Failures` |
| Jobs | `Azure Portal > Container App Jobs > [pdfval-worker or pdfval-maintenance] > Monitoring > Execution history` |
| Changes | `Azure Portal > Resource groups > pdf-validation-prod > Activity log` |
| Deployments | `Azure Portal > Resource groups > pdf-validation-prod > Settings > Deployments`; [Deploy Azure](https://github.com/ivanbueno/portal-pdf-validation/actions/workflows/deploy.yml) |
| Azure outage | `Azure Portal > Service Health > Service issues` |

**Safe:** Read, capture sanitized evidence, retry a read/sign-in once. **Requires approval:** Any production change or restart. **Never repeat a failed restart.** Escalate with impact, UTC timeline, error/request IDs, app status, metrics, logs, deployment and actions already tried.
