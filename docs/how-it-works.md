# How it works

[← Back to overview](../README.md)

FastAPI serves the portal and API on Azure Container Apps. Isolated Java/veraPDF jobs validate each uploaded PDF against PDF/UA-1 and the vendored custom WCAG 2.2 profile ([`profiles/WCAG-2-2-Complete.xml`](../profiles/WCAG-2-2-Complete.xml)).

```mermaid
flowchart LR
    Browser[Staff browser] --> Entra[Microsoft Entra ID / Easy Auth]
    Client[Approved API client] --> Entra
    Browser --> API[FastAPI / Azure Container Apps]
    Client --> API
    Browser -->|Scoped upload SAS| Blob[Private Blob Storage]
    Client -->|Scoped upload SAS| Blob
    API --> Table[Table Storage: ownership and job state]
    API --> Queue[Storage Queue]
    Queue --> Worker[Container Apps Jobs: veraPDF]
    Worker --> Blob
    Worker --> Table
    Maintenance[Scheduled reconciliation and cleanup] --> Table
    Maintenance --> Queue
    Maintenance --> Blob
```

## A document's journey

```mermaid
sequenceDiagram
    actor Staff
    participant Portal as Portal / API
    participant Blob as Private Blob Storage
    participant Worker as veraPDF job
    Staff->>Portal: Request upload (file name and size only)
    Portal-->>Staff: Short-lived, single-file upload grant
    Staff->>Blob: Upload PDF directly
    Staff->>Portal: Submit
    Portal->>Blob: Verify size and signature, pin immutable snapshot
    Portal->>Worker: Queue the document
    Worker->>Blob: Validate snapshot, write report per standard
    Staff->>Portal: Poll status and read results
    Note over Portal,Blob: After 72 hours the PDF and reports are removed
```

## Security

- Azure Entra Easy Auth handles browser sessions and integration token validation. Visitors without an authorized session see a sign-in card over the blurred, inert workspace shell, which holds no document data; the card appears whenever `/api/session` rejects them. The portal uses server-directed sign-in and the same versioned API as integrations.
- Upload requests carry metadata only; PDFs go directly to Blob Storage with short-lived, per-blob write grants. An owner-protected endpoint streams the submitted snapshot for viewing in a new tab.
- Submission checks the actual size and signature and pins an immutable snapshot before queueing. Original filenames are display metadata, never blob paths or shell arguments.
- Every document is scoped to its tenant and owner. Production rejects the local development identity.

## Reliability

- ETag claims and attempt-specific report paths prevent duplicate messages, stale workers and deletion races from publishing the wrong result. Queue delivery is at least once, not exactly once.
- Each queued document is its own durable outbox. Maintenance retries undispatched work and recovers expired worker leases.
- A document gets at most three processing attempts for infrastructure failures; deterministic validation failures are not retried.
- Every file produces separate profile results. A processing error is distinct from a nonconforming PDF, and a successful profile report survives another profile's failure.

## Data lifecycle

```mermaid
timeline
    title What happens after a PDF is uploaded
    0 min : Uploaded straight to private storage : Exact copy frozen and queued
    Minutes : Isolated job checks each standard : Up to 5 minutes per standard
    1 hour : Unsubmitted upload reservations expire
    72 hours : PDF and reports become inaccessible and are deleted
```


- Upload reservations expire after one hour. Submitted files and reports become inaccessible after 72 hours, and users can delete them sooner.
- Cleanup runs every two minutes in Azure (every 30 seconds locally). Deletion tombstones persist beyond outstanding upload grants and worker leases to catch late writes.

## Performance and capacity

- Fast portal polls read only active metadata. Document lists use stable cursors, and new report pages read only their intersecting stored chunks. Full JSON/XML downloads stream from storage. Exact workspace totals and filename filtering still require scanning the owner's live metadata.
- One worker processes one PDF and runs profiles sequentially. Azure starts with at most four executions, each 2 vCPU/4 GiB, a 2 GiB JVM heap, five minutes per profile, and a 20 MiB combined stdout/stderr limit per profile.
- The API creates one document per request; the portal coordinates multi-file selections.

## Azure resources

The **Deploy Azure** workflow provisions everything below into one resource group from [`infra/foundation.bicep`](../infra/foundation.bicep) and [`infra/main.bicep`](../infra/main.bicep). Names use the `prefix` parameter (default `pdfval`); `<suffix>` is a stable hash of the resource group ID.

```mermaid
flowchart TB
    subgraph RG["Resource group"]
        subgraph ENV["pdfval-env"]
            API["pdfval-api<br/>Container App<br/>0.5 vCPU · 1 GiB · 1–3 replicas"]
            W["pdfval-worker<br/>Event job · queue-triggered<br/>2 vCPU · 4 GiB · max 4"]
            M["pdfval-maintenance<br/>Scheduled job · every 2 min<br/>0.5 vCPU · 1 GiB"]
        end
        ID["pdfval-runtime<br/>Managed identity"]
        ACR["Container Registry<br/>Basic"]
        ST["Storage account · Standard LRS<br/>blob: documents · queue: validation · table: validation"]
        LOG["pdfval-logs<br/>Log Analytics · 30 days"]
        AL["Alerts + action group"]
    end
    API & W & M -. run as .-> ID
    ID -->|AcrPull| ACR
    ID -->|Blob/Queue/Table data roles| ST
    ENV --> LOG
    LOG & ST & W & M --> AL
```

### Compute

| Resource | Type | Size and scale | Other settings |
|---|---|---|---|
| `pdfval-env` | Container Apps managed environment | Consumption plan (no dedicated workload profiles) | Sends app logs to `pdfval-logs` |
| `pdfval-api` | Container App | 0.5 vCPU, 1 GiB per replica; **1–3 replicas**, scaling at 30 concurrent HTTP requests per replica | External HTTPS ingress only (port 8000, insecure traffic refused); single active revision; liveness and readiness probes every 30 s |
| `pdfval-worker` | Container Apps job, event-triggered | **2 vCPU, 4 GiB** per execution; 0 to **4 concurrent executions**, one per queued message, polled every 10 s | 15-minute execution timeout; no platform retry (the app manages up to three attempts) |
| `pdfval-maintenance` | Container Apps job, scheduled | 0.5 vCPU, 1 GiB | Cron `*/2 * * * *` (every 2 minutes); 10-minute timeout; 1 retry |

All three run the same image from the registry, tagged with the deployed Git SHA.

### Data

| Resource | Tier and settings | Contents |
|---|---|---|
| Storage account `pdfval<suffix>` | StorageV2, **Standard LRS** (locally redundant); TLS 1.2 minimum, HTTPS only, public blob access off, **shared-key access off** (Entra ID only) | — |
| Blob container `documents` | Private | Uploaded PDFs, immutable snapshots and reports. CORS allows only `PUT`/`OPTIONS` from the portal origin (1-hour preflight cache) so browsers can upload directly |
| Queue `validation` | Standard queue | One message per submitted document; drives worker scaling |
| Table `validation` | Standard table | Document ownership, job state, idempotency keys and tombstones |

Storage versioning, soft delete and backups are **not** enabled. Documents are short-lived by design (72 hours).

### Identity and access

| Resource | Details |
|---|---|
| `pdfval-runtime` | User-assigned managed identity shared by the API and both jobs. No secrets or connection strings are used for storage or the registry |
| Storage role assignments | Storage Blob Data Contributor, Storage Blob Delegator (to issue short-lived user-delegation upload grants), Storage Queue Data Contributor, Storage Table Data Contributor — scoped to the storage account |
| Registry role assignment | AcrPull on the registry |
| Easy Auth (`authConfigs`) | Microsoft Entra ID provider on the API; returns 401 to unauthenticated requests except `/`, `/assets/*`, `/api/config` and the health endpoints; HTTPS required. The Entra client secret is stored as a Container App secret |
| Container Registry `pdfval<suffix>` | **Basic** tier; admin user disabled (pulls use the managed identity) |

The Entra app registration, resource group and GitHub OIDC identity are created once by an administrator, not by the templates. See [Deploy to Azure](azure-ci.md).

### Monitoring

| Resource | Details |
|---|---|
| `pdfval-logs` | Log Analytics workspace, **pay-as-you-go (PerGB2018)**, **30-day retention** |
| `pdfval-alerts` | Action group; emails the optional `alertEmail` operator address |
| `pdfval-processing-failures` | Log alert, severity 2, every 5 minutes over 15 minutes: any validation infrastructure error or maintenance run with failures |
| `pdfval-queue-backlog` | Metric alert, severity 2: more than **1,000 queued messages** (hourly average) |
| `pdfval-worker-failed`, `pdfval-maintenance-failed` | Metric alerts, severity 2: any failed job execution in a 5-minute window, including platform termination |

See the [deployment guide](azure-ci.md) for provisioning and the [verification record](verification.md) for what has been tested.
