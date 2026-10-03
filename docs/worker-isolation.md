# Worker isolation

The worker uses `<prefix>-worker`, a different managed identity from the API and maintenance job's `<prefix>-runtime`. Its image pull, queue scaler and application credential all use the worker identity. Never attach the runtime identity to the worker, even only for image pulls: a compromised container could request its tokens.

The Bicep templates reduce the permissions and network access available after a worker compromise. They do **not** isolate one tenant or document from other documents processed by the same worker identity. H1 remains partially mitigated until the parser is isolated from the coordinator's credentials.

## Permissions

`infra/worker-access.bicep` creates these grants:

| Scope | Allowed operations | Excluded operations |
| --- | --- | --- |
| Blob container `documents` | Read `*/*/input.pdf` only when the request specifies a snapshot; write JSON/XML under `*/*/reports/`; both require Private Link | Base-PDF reads, report reads, Blob listing, input writes, Blob deletion, tags, delegation keys, container administration |
| Queue `validation` | Get queue metadata for scaling; peek, receive and delete messages | Send/update messages, clear/delete/create queues |
| Table `validation` | Read and update existing entities for claims/status | Insert/delete entities, table administration |
| Registry | AcrPull | Image push or registry administration |

The Blob custom role contains only `blobs/read` and `blobs/write`; its ABAC condition explicitly denies `Blob.List` and requires the snapshot request attribute. A positive read/write allowlist avoids exempting unintended actions. `StringLike` wildcards match across slashes, so the report namespace and JSON/XML suffixes matter; wildcard segment counts alone are not a security boundary. See Microsoft's [ABAC attributes](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-auth-abac-attributes) and [Blob condition examples](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-auth-abac-examples).

New reports use `<owner>/<document>/reports/<run>/`. Existing report URLs remain readable by the API through stored paths. A worker that loses its claim leaves its unpublished outputs for maintenance to remove on document deletion/expiry; it no longer needs Blob list/delete rights.

## Network

`infra/worker-network.bicep` creates an internal workload-profiles environment (`<prefix>-worker-env`, Consumption profile) in a dedicated VNet. The worker subnet has explicit inbound and outbound deny rules ahead of Azure's default allow rules. Blob, Queue, Table and ACR have private endpoints with linked private DNS zones. Premium ACR is required for its registry and image-layer private endpoints. Public storage upload/API access and ACR build access continue to use the existing public service endpoints outside this VNet.

Outbound exceptions are HTTPS to the private-endpoint subnet, intra-worker-subnet traffic, Azure DNS on port 53, and HTTPS to these Azure platform service tags: `MicrosoftContainerRegistry`, `AzureFrontDoor.FirstParty`, `AzureActiveDirectory`, `AzureMonitor`. There is no broad `Internet`, `Storage`, `AzureContainerRegistry` or `AzureCloud` allow rule. This follows the [Container Apps NSG requirements](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration) and [ACR Private Link requirements](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-private-endpoints).

This blocks general internet connections, but it is not an air gap: the required platform destinations and DNS remain potential exfiltration channels. Container Apps' local [managed-identity endpoint](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity) also remains reachable inside the job. VNet rules do not isolate Java from that endpoint or from the Python coordinator. Do not peer this VNet with other networks or place unrelated workloads in its subnets.

## Existing deployments

The Job model used by Bicep marks `environmentId` create-only in the [Azure Jobs API specification](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/app/resource-manager/Microsoft.App/ContainerApps/stable/2025-01-01/Jobs.json). Its separate PATCH model permits updates, but cross-environment PATCH migration has not been verified here; this rollout uses job replacement. Plan a validation interruption for the first upgrade; the API and queued documents can remain available. The deployment workflow checks for the old environment before provisioning and stops with a migration message; it does not silently delete a running job.

1. Compile the templates and run the tests. Ensure `Microsoft.Network` is registered. The deployment principal needs `Microsoft.Authorization/roleDefinitions/write` as well as role-assignment permissions in the resource group. Contributor plus User Access Administrator provides these permissions; Contributor plus Role Based Access Control Administrator alone cannot create custom roles. Use narrower deployment permissions where available. See [Azure custom-role permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/custom-roles#who-can-create-delete-update-or-view-a-custom-role).
2. Budget for Premium ACR and four private endpoints. The foundation deployment upgrades ACR, creates the worker identity, grants and private environment. New deployments need no replacement step.
3. For an existing installation, remove only the old `<prefix>-worker` job before the application deployment, using the normal release/change process. Deleting the job terminates its remaining executions. Their queue visibility timeout and document lease allow the new worker/maintenance to retry; validation may be delayed by one lease interval. Do not remove the queue, table, storage, API, maintenance job or runtime identity.

   ```sh
   # Set RESOURCE_GROUP and PREFIX to the reviewed deployment target first.
   az containerapp job show --resource-group "$RESOURCE_GROUP" --name "$PREFIX-worker" \
     --query '{name:name,environment:properties.environmentId}' --output table
   # One-time replacement only when the job still uses <prefix>-env:
   az containerapp job delete --resource-group "$RESOURCE_GROUP" --name "$PREFIX-worker" --yes
   ```

4. Run the normal application deployment (the Deploy Azure workflow for CI-managed installations). It creates the same worker job name in `<prefix>-worker-env` with only `<prefix>-worker` attached. For a manual deployment, use `infra/main.bicep` as usual. Allow time for RBAC propagation before investigating an initial authorization failure.
5. Verify the checks below. Audit inherited role assignments: a broad grant added outside these templates bypasses ABAC because Azure permissions are additive. Confirm there are no old worker executions or alternative worker jobs running with `<prefix>-runtime`. Do not roll back only the worker code to a release that writes outside `/reports/`; those writes are intentionally denied.

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
