# Azure resource naming

Fresh deployments use `{env}-{project}-{resource-group-type}-{resource-type}-{function-if-applicable}-{instance-num-2-digit-if-applicable}`. The default environment is `prod` and project is `pdfportal`. A function identifies a specific purpose, such as `runtime`, `worker`, `api`, `blob` or `backlog`. Omit the function when the resource type already describes its purpose. Omit the instance number when the type/function has only one instance; omit its separator too. All resources in this deployment have distinct types/functions, so their names have no instance numbers.

If multiple instances of the same type/function are introduced, use stable two-digit suffixes such as `-01` and `-02`, and check the resulting full names against Azure's length limits. `maint` abbreviates maintenance to fit the Container Apps job name limit.

[`infra/names.json`](../infra/names.json) is the shared suffix map loaded by every Bicep module and [`scripts/azure_names.py`](../scripts/azure_names.py). GitHub uses `AZURE_ENV` and `AZURE_PROJECT`; the Bicep entry points accept `env` and `project`. `AZURE_LOCATION` selects the Azure region. The former prefix and resource-group-base inputs are replaced by these tokens.

Environment tokens contain 1–5 lowercase letters/digits and project tokens contain 1–10; both begin with a letter. These limits keep the compact storage name within 24 characters and the current job names below 32 characters, as required by the [Container Apps job CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/job?view=azure-cli-latest). The CLI helper validates tokens before provisioning. `env` is a naming token; Azure workloads retain the production authentication settings regardless of its value.

Print the actual names before deploying:

```sh
python3 scripts/azure_names.py --env prod --project pdfportal
```

Use `--format shell` for the resource-group, workload and deployment variables consumed by the workflow and manual runbook. It emits `ADMIN_RESOURCE_GROUP`, `NET_RESOURCE_GROUP`, `APP_RESOURCE_GROUP`, `DATA_RESOURCE_GROUP`, `API_NAME`, `WORKER_NAME`, `MAINTENANCE_NAME`, `FOUNDATION_DEPLOYMENT` and `PORTAL_DEPLOYMENT`. The JSON output includes the complete inventory. Module responsibilities are listed in [template ownership](azure-container-apps-architecture.md#template-ownership).

The default inventory is:

| Resource / purpose | Name |
| --- | --- |
| Admin resource group | `prod-pdfportal-admin-rg` |
| Network resource group | `prod-pdfportal-net-rg` |
| Application resource group | `prod-pdfportal-app-rg` |
| Data resource group | `prod-pdfportal-data-rg` |
| API / maintenance managed identity | `prod-pdfportal-admin-id-runtime` |
| Worker managed identity | `prod-pdfportal-admin-id-worker` |
| Premium Container Registry | `prodpdfportaladminacr` |
| Log Analytics workspace | `prod-pdfportal-admin-law` |
| Action group | `prod-pdfportal-admin-ag` |
| Processing failures log alert | `prod-pdfportal-admin-sqr-processing` |
| Queue backlog metric alert | `prod-pdfportal-admin-ma-backlog` |
| Worker failure metric alert | `prod-pdfportal-admin-ma-worker` |
| Maintenance failure metric alert | `prod-pdfportal-admin-ma-maint` |
| Worker VNet | `prod-pdfportal-net-vnet-worker` |
| Worker NSG | `prod-pdfportal-net-nsg-worker` |
| Worker subnet | `prod-pdfportal-net-snet-worker` |
| Private endpoint subnet | `prod-pdfportal-net-snet-endpoints` |
| Blob private endpoint | `prod-pdfportal-net-pep-blob` |
| Queue private endpoint | `prod-pdfportal-net-pep-queue` |
| Table private endpoint | `prod-pdfportal-net-pep-table` |
| Registry private endpoint | `prod-pdfportal-net-pep-acr` |
| Blob private DNS VNet link | `prod-pdfportal-net-pdnslink-blob` |
| Queue private DNS VNet link | `prod-pdfportal-net-pdnslink-queue` |
| Table private DNS VNet link | `prod-pdfportal-net-pdnslink-table` |
| Registry private DNS VNet link | `prod-pdfportal-net-pdnslink-acr` |
| API / maintenance Container Apps environment | `prod-pdfportal-app-cae-shared` |
| Worker Container Apps environment | `prod-pdfportal-app-cae-worker` |
| API Container App | `prod-pdfportal-app-ca-api` |
| Worker Container Apps job | `prod-pdfportal-app-caj-worker` |
| Maintenance Container Apps job | `prod-pdfportal-app-caj-maint` |
| Storage account | `prodpdfportaldatast` |
| Worker Blob custom role display name | `prod-pdfportal-data-role-blob` |
| Worker Queue custom role display name | `prod-pdfportal-data-role-queue` |
| Worker Table custom role display name | `prod-pdfportal-data-role-table` |
| Foundation deployment (subscription) | `prod-pdfportal-admin-deploy-foundation` |
| Portal deployment (subscription) | `prod-pdfportal-app-deploy-portal` |
| Admin module deployment | `prod-pdfportal-admin-deploy-resources` |
| Data module deployment | `prod-pdfportal-data-deploy-storage` |
| Network module deployment | `prod-pdfportal-net-deploy-worker` |
| Environments module deployment | `prod-pdfportal-app-deploy-environments` |
| App module deployment | `prod-pdfportal-app-deploy-workloads` |
| Monitoring module deployment | `prod-pdfportal-admin-deploy-monitoring` |
| Worker access module deployment | `prod-pdfportal-data-deploy-access` |

## Azure and application exceptions

- Container Registry and Storage account names remove the hyphens and preserve the applicable tokens. Both must be globally available; check availability before the first deployment and choose another project token if needed. No hash or random suffix is added. Role definition and role assignment resource names remain deterministic GUIDs; custom role display names follow the convention. See [Azure resource naming rules](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules).
- Private DNS zone names remain `privatelink.blob.core.windows.net`, `privatelink.queue.core.windows.net`, `privatelink.table.core.windows.net` and `privatelink.azurecr.io` in public Azure. The storage zones follow the Azure cloud's storage suffix. See [Private Link DNS names](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns).
- Service children retain `default` for storage services and private DNS zone groups, and `current` for Easy Auth. Blob container `documents`, queue `validation` and table `validation` retain the application contract. Internal configuration labels, including container names, scale rules, NSG rules and secret keys, remain descriptive.
- The action group's short display name is `pdfportal` because this field is limited to 12 characters; its resource name follows the full convention.
- Azure may create a separate service-managed infrastructure group for the worker environment. Its generated name/lifecycle is owned by Azure.

Keep the same environment and project on subsequent runs. This is a fresh-deployment naming change, not a migration or rename of existing Azure resources.
