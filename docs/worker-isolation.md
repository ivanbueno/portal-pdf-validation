# Worker isolation

The worker uses `prod-pdfportal-admin-id-worker`, a different managed identity from the API and maintenance job's `prod-pdfportal-admin-id-runtime`. Its image pull, queue scaler and application credential all use the worker identity. Never attach the runtime identity to the worker, even only for image pulls: a compromised container could request its tokens.

The Bicep templates reduce the permissions and network access available after a worker compromise. They do **not** isolate one tenant or document from other documents processed by the same worker identity. H1 remains partially mitigated until the parser is isolated from the coordinator's credentials.

## Permissions

`infra/worker-access.bicep` creates the storage grants in data for the worker identity in admin. `infra/admin.bicep` grants that identity AcrPull on the registry:

| Scope | Allowed operations | Excluded operations |
| --- | --- | --- |
| Blob container `documents` | Read `*/*/input.pdf` only when the request specifies a snapshot; write JSON/XML under `*/*/reports/`; both require Private Link | Base-PDF reads, report reads, Blob listing, input writes, Blob deletion, tags, delegation keys, container administration |
| Queue `validation` | Get queue metadata for scaling; peek, receive and delete messages | Send/update messages, clear/delete/create queues |
| Table `validation` | Read and update existing entities for claims/status | Insert/delete entities, table administration |
| Registry | AcrPull | Image push or registry administration |

The Blob custom role contains only `blobs/read` and `blobs/write`; its ABAC condition explicitly denies `Blob.List` and requires the snapshot request attribute. A positive read/write allowlist avoids exempting unintended actions. `StringLike` wildcards match across slashes, so the report namespace and JSON/XML suffixes matter; wildcard segment counts alone are not a security boundary. See Microsoft's [ABAC attributes](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-auth-abac-attributes) and [Blob condition examples](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-auth-abac-examples).

Reports use `<owner>/<document>/reports/<run>/`. A worker that loses its claim leaves its unpublished outputs for maintenance to remove on document deletion/expiry; it does not need Blob list/delete rights.

## Network

`infra/worker-network.bicep` creates the dedicated VNet, NSG, private endpoints and DNS zones in net. `infra/environments.bicep` creates the internal workload-profiles environment (`prod-pdfportal-app-cae-worker`, Consumption profile) in app using the subnet ID from net and Log Analytics in admin. The worker subnet has explicit inbound and outbound deny rules ahead of Azure's default allow rules. Blob, Queue, Table and ACR have private endpoints with linked private DNS zones. Premium ACR is required for its registry and image-layer private endpoints. Public storage upload/API access and ACR build access use public service endpoints outside this VNet.

Outbound exceptions are HTTPS to the private-endpoint subnet, intra-worker-subnet traffic, Azure DNS on port 53, and HTTPS to these Azure platform service tags: `MicrosoftContainerRegistry`, `AzureFrontDoor.FirstParty`, `AzureActiveDirectory`, `AzureMonitor`. There is no broad `Internet`, `Storage`, `AzureContainerRegistry` or `AzureCloud` allow rule. This follows the [Container Apps NSG requirements](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration) and [ACR Private Link requirements](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-endpoints).

This blocks general internet connections, but it is not an air gap: the required platform destinations and DNS remain potential exfiltration channels. Container Apps' local [managed-identity endpoint](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity) also remains reachable inside the job. VNet rules do not isolate Java from that endpoint or from the Python coordinator. Do not peer this VNet with other networks or place unrelated workloads in its subnets.

## First deployment

Follow the [CI deployment guide](azure-ci.md) or [manual provisioning runbook](azure-manual.md) to provision a fresh installation. The subscription-scope templates create admin, net, app and data resource groups with separate runtime and worker identities, the worker's scoped grants, and its private environment from the outset. Include Premium ACR and four private endpoints in the deployment budget.

Compile the templates and run the tests. Ensure `Microsoft.Network` is registered. The deployment principal needs `Microsoft.Authorization/roleDefinitions/write` as well as role-assignment permissions in data and admin, plus subscription deployment/resource-group creation permissions. Contributor plus User Access Administrator at subscription scope provides these permissions; Contributor plus Role Based Access Control Administrator alone cannot create custom roles. Use narrower deployment permissions where available. See [Azure custom-role permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/custom-roles#who-can-create-delete-update-or-view-a-custom-role).

After deployment, allow time for RBAC propagation before investigating an initial authorization failure, then complete the checks below. Audit inherited role assignments: a broad grant added outside these templates bypasses ABAC because Azure permissions are additive.

## Deployment verification

Local tests and Bicep compilation do not exercise Azure RBAC, private DNS or the Container Apps control plane. In the approved Azure test deployment, use a disposable document and the **worker identity inside its environment**, not an operator credential, to verify:

| Check | Expected |
| --- | --- |
| Job identity, registry identity, scaler identity, `AZURE_CLIENT_ID` | Only the worker identity; API/maintenance retain runtime identity |
| Storage/registry DNS, including ACR data endpoint | Resolve to private addresses in the worker private-endpoint subnet |
| Queue-triggered validation of a newly submitted PDF | Completes, publishes XML/JSON and paged reports; maintenance cleanup still succeeds |
| Read submitted `input.pdf?snapshot=...` | Allowed |
| Read base `input.pdf`, read report, list blobs | HTTP 403 |
| Write report JSON/XML under the run's `/reports/` path | Allowed |
| Write/delete `input.pdf`, delete a report, get user delegation key | HTTP 403 |
| Send/update a queue message; insert/delete a table entity | HTTP 403; use disposable fixtures only |
| Read/update the existing disposable validation row; consume its queue message | Allowed |
| HTTPS to an unrelated public endpoint; DNS to an external resolver | Blocked/times out |
| Request API/runtime identity through the worker's identity endpoint | Denied/unavailable |

Record the response status without logging document content or tokens. Remove disposable fixtures using the maintenance/API identity. Do not relax ABAC or add broad service tags to resolve an image-pull or DNS failure; inspect private endpoint approval, ACR data DNS records, role propagation and the mandatory platform rules first.

## Remaining boundary

The worker identity can read all submitted snapshots whose names it knows and overwrite report paths across tenants. It can update every row in `validation`; marking a row deleted or expired can cause trusted maintenance to purge that document. Azure Table permissions cannot restrict updates to particular properties through Blob ABAC. Denying direct Blob deletion therefore does not prevent this indirect deletion path.

To close H1 fully, isolate the untrusted parser from the credential-bearing coordinator and issue capabilities restricted to one immutable input and one attempt's outputs, or add a trusted broker that enforces document/attempt ownership and allowed state transitions. Environment-variable filtering alone is insufficient while both processes share an identity endpoint and operating-system identity. Track parser sandboxing and timely veraPDF updates in [the security backlog](security-todo.md#h1-a-worker-parser-exploit-would-expose-every-users-documents).
