# Azure Container Apps infrastructure

Architecture defined by [`infra/foundation.bicep`](../infra/foundation.bicep) and [`infra/main.bicep`](../infra/main.bicep). This describes the repository configuration; it is not a verification of live Azure resources. Resource names use the default `pdfval` prefix.

```mermaid
flowchart TB
    Clients["Staff browser / approved API clients"]
    Entra["Microsoft Entra ID<br/>App registration and roles"]
    Clients <-->|"Sign-in / tokens"| Entra

    subgraph RG["Azure resource group"]
        subgraph ENV["pdfval-env · Container Apps environment"]
            subgraph APP["pdfval-api · Container App"]
                Auth["HTTPS ingress + Easy Auth"]
                API["Portal + FastAPI<br/>0.5 vCPU · 1 GiB per replica<br/>1–3 replicas"]
                Auth --> API
            end
            Worker["pdfval-worker · Event job<br/>Java / veraPDF<br/>2 vCPU · 4 GiB per execution<br/>0–4 concurrent executions"]
            Maintenance["pdfval-maintenance · Scheduled job<br/>Every 2 minutes<br/>0.5 vCPU · 1 GiB"]
        end

        subgraph Storage["Storage account · Standard LRS"]
            Blob["Private Blob container: documents<br/>PDFs, snapshots, reports"]
            Queue["Storage Queue: validation"]
            Table["Table Storage: validation<br/>Ownership and job state"]
        end

        Identity["pdfval-runtime<br/>User-assigned managed identity<br/>Storage data roles + AcrPull"]
        ACR["Azure Container Registry · Basic<br/>Shared image tagged with Git SHA"]
        Logs["pdfval-logs · Log Analytics<br/>30-day retention"]
        Alerts["Alerts + action group<br/>Processing errors, backlog, failed jobs"]

        API -->|"Enqueue"| Queue
        Queue -->|"Queue depth triggers executions"| Worker
        API & Worker --> Blob
        API & Worker --> Table
        Maintenance -->|"Reconcile / clean up"| Storage
        ENV -.->|"All workloads run as"| Identity
        Identity -.->|"RBAC"| Storage
        Identity -.->|"AcrPull"| ACR
        ENV -.->|"Application logs"| Logs
        Logs --> Alerts
        Queue -.->|"Backlog metric"| Alerts
        Worker & Maintenance -.->|"Failed executions"| Alerts
    end

    Clients -->|"HTTPS"| Auth
    Auth -.->|"Identity provider"| Entra
    Clients -->|"Direct upload using scoped SAS"| Blob
```

Solid arrows show requests, data access, triggers, or log-alert evaluation. Dashed arrows show identity and monitoring relationships. All three workloads use the same release image from ACR. The queue-trigger arrow describes the platform scaler; workers also receive and acknowledge messages directly from the queue.

Microsoft Entra ID is outside the resource group. Easy Auth belongs to the API Container App and validates browser sessions and API tokens before FastAPI authorizes access. A private Blob container disables anonymous data access; this configuration does not create a private endpoint. Uploads go directly from the client to Blob Storage, while PDFs and reports are retained for 72 hours.
