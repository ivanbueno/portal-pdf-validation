# Fresh Azure deployment with Entra Easy Auth

This guide provisions a new PDF Validation Portal in Azure Container Apps. Azure Container Apps Easy Auth handles staff sign-in, session cookies, and access-token validation before requests reach FastAPI. FastAPI authorizes the validated claims and scopes documents to their owner. The browser does not store access tokens. Follow the steps in order: the first deployment creates the app hostname needed for the Entra Web redirect URI and Blob Storage CORS rule.

## What you will create

- One single-tenant Entra application registration for the portal and API.
- A resource group containing Container Apps, Container Registry, Storage, a user-assigned managed identity, Log Analytics, and alert rules.
- An externally reachable HTTPS Container App. Easy Auth protects the API and sign-in endpoints; only the sign-in page, static assets, configuration, and health checks are public. The app serves the workspace page only to signed-in, authorized users.
- A worker Container Apps job and a scheduled maintenance job.

Choose a dedicated, otherwise unused resource group and a lowercase alphanumeric resource prefix 3–10 characters long. The examples use `pdf-validation-prod`, `westus2`, and `pdfval`; change these to match your environment. The templates do not configure custom domains, private networking, or API Management.

## 1. Prepare tools, access, and Azure

1. Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and Docker only if you plan to build locally. The steps below use ACR remote builds, so Docker is not required.
2. Sign in with an account allowed to create Entra app registrations and grant tenant consent as needed. For Azure resource deployment, use an account with Contributor and Role Based Access Control Administrator permissions scoped to the resource group (or equivalent custom permissions). ACR builds and managed identity role assignments are part of provisioning.
3. Sign in and select the target subscription:

   ```sh
   az login
   SUBSCRIPTION_ID="YOUR_SUBSCRIPTION_ID"
   az account set --subscription "$SUBSCRIPTION_ID"
   az account show --output table
   ```

4. Set deployment variables and create the empty resource group:

   ```sh
   RESOURCE_GROUP=pdf-validation-prod
   LOCATION=westus2
   PREFIX=pdfval
   az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
   ```

5. Register the resource providers used by the templates. Registration may take several minutes; check each state before proceeding:

   ```sh
   for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.Storage Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.Insights Microsoft.Authorization; do
     az provider register --namespace "$provider"
   done
   az provider show --namespace Microsoft.App --query registrationState --output tsv
   ```

   Repeat `az provider show` for any provider still registering. Resource group deployment also requires permission to create role assignments.

## 2. Create the Entra application registration

Create the registration before deployment because its tenant ID and application (client) ID are deployment parameters. You will add its redirect URI after Azure assigns the app hostname.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), go to **Identity > Applications > App registrations > New registration**.
2. Name it `PDF Validation Portal`. Choose **Accounts in this organizational directory only**. Leave redirect URI empty for now. Select **Register**, then record **Directory (tenant) ID** and **Application (client) ID**.
3. Open **Expose an API**. Set the Application ID URI to `api://<APPLICATION_CLIENT_ID>` (use the suggested value if it matches). In the app manifest, set `api.requestedAccessTokenVersion` to `2`.
4. Add a delegated scope named `Validation.Access` for approved clients that call on behalf of a user. Configure its consent text and state as enabled. This scope is for integrations; staff browser sessions use Easy Auth.
5. Open **App roles > Create app role**. Add:
   - Display name: `Validation User`; allowed member types: **Users/Groups**; value: `Validation.User`; enabled.
   - Display name: `Validation Run`; allowed member types: **Applications**; value: `Validation.Run`; enabled.
6. Open **Certificates & secrets > Client secrets > New client secret**. Create a secret with an expiry that matches your rotation policy. Copy its **Value** immediately; it is supplied to Easy Auth in step 4. It is not an API credential for the Python application. Redeploy with a new value before it expires.
7. In **Enterprise applications**, open the service principal for this registration and assign authorized staff or groups the `Validation.User` app role. Assign `Validation.Run` only to approved integration service principals. Configure assignment requirements, admin consent, and Conditional Access/MFA to meet your organization's policy.

For machine integrations, each approved client uses its own service principal and credentials or federation. Client-credentials clients request `api://<APPLICATION_CLIENT_ID>/.default` and send the resulting bearer token. The application role `Validation.Run` is required. Delegated clients use `Validation.Access`.

## 3. Provision shared resources and build the image

Run commands from the repository root. First deploy the foundation (identity, registry, storage, queue/table, monitoring workspace, and Container Apps environment), then build the app image in ACR. The initial storage CORS origin is a placeholder; step 5 replaces it with the actual portal origin.

```sh
az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
  --template-file infra/foundation.bicep --parameters prefix="$PREFIX"
REGISTRY=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
  --query properties.outputs.registryName.value --output tsv)
IMAGE_TAG=$(git rev-parse --short=12 HEAD)
az acr build --registry "$REGISTRY" --image "pdf-validation:$IMAGE_TAG" .
```

Use an immutable release identifier for `IMAGE_TAG` in production; do not reuse a tag for different image contents.

## 4. Deploy the app and Easy Auth

Supply the Entra client secret using a short-lived, permission-restricted parameter file. This avoids putting the secret in shell history or a committed file. The deployment template stores it as a Container App secret used by Easy Auth; it is not passed into the Python container.

```sh
SECRET_PARAMS=$(mktemp)
chmod 600 "$SECRET_PARAMS"
trap 'rm -f "$SECRET_PARAMS"' EXIT
python3 - "$SECRET_PARAMS" <<'PY'
import getpass, json, sys
secret = getpass.getpass('Entra Easy Auth client secret value: ')
if not secret:
    raise SystemExit('Client secret is required')
with open(sys.argv[1], 'w') as output:
    json.dump({'entraClientSecret': {'value': secret}}, output)
PY

TENANT_ID="DIRECTORY_TENANT_ID"
API_CLIENT_ID="APPLICATION_CLIENT_ID"
ALERT_EMAIL=operations@example.com
az deployment group create --resource-group "$RESOURCE_GROUP" --name portal \
  --template-file infra/main.bicep \
  --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" tenantId="$TENANT_ID" \
  apiClientId="$API_CLIENT_ID" alertEmail="$ALERT_EMAIL" \
  "@$SECRET_PARAMS"
ORIGIN=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name portal \
  --query properties.outputs.portalUrl.value --output tsv)
rm -f "$SECRET_PARAMS"
trap - EXIT
printf 'Portal origin: %s\n' "$ORIGIN"
```

The `infra/main.bicep` deployment creates the API app, enables HTTPS ingress, configures Entra Easy Auth with the tenant-specific v2 issuer and this API's audiences, then creates the worker and maintenance jobs and alert rules. Unauthenticated protected requests return 401. The token store is not enabled. The runtime uses managed identity for storage and registry access.

## 5. Finish Entra callback and Blob CORS setup

1. In the app registration, go to **Authentication > Add a platform > Web**. Add this redirect URI, replacing the value with the origin printed in step 4:

   ```text
   https://<CONTAINER_APP_HOSTNAME>/.auth/login/aad/callback
   ```

   This is a **Web** redirect URI. Save the change. The Easy Auth login flow requires this callback.
2. Update the foundation deployment with the real origin. This restricts direct browser uploads to the deployed portal:

   ```sh
   az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
     --template-file infra/foundation.bicep \
     --parameters prefix="$PREFIX" portalOrigin="$ORIGIN"
   ```

3. Check that the public health endpoint responds, then open the portal and sign in:

   ```sh
   curl --fail --retry 12 --retry-delay 10 --retry-all-errors "$ORIGIN/health/ready"
   ```

   Visitors without a session see a sign-in card over the blurred workspace at `https://<CONTAINER_APP_HOSTNAME>/`, whose button starts sign-in at `/.auth/login/aad`; sign-out uses `/.auth/logout` and returns to `/?signed-out`.

Keep `portalOrigin="$ORIGIN"` when redeploying both `infra/foundation.bicep` and `infra/main.bicep`, so the Blob upload CORS rule remains aligned with the app hostname. If the app is recreated and its hostname changes, update the Web redirect URI and redeploy foundation with the new origin.

## 6. Optional: set up GitHub Actions OIDC deployment

The included **Deploy Azure** workflow is a manual release workflow. It builds a Git-SHA-tagged image in ACR, deploys the app, updates the Blob CORS origin, and prints the portal URL. Complete the first Azure deployment above before relying on it; create the resource group first and use the same prefix and Entra registration.

1. Create a deployment service principal and federated identity credential that trusts this repository's GitHub **production** environment. Grant it Contributor, Role Based Access Control Administrator, and ACR build permissions scoped to the resource group (or equivalent least-privilege permissions). First-run managed-identity role assignments may need time to propagate; do not enable ACR admin credentials as a workaround.
2. In the GitHub repository, create a `production` environment. Add these environment **variables**:
   - `AZURE_DEPLOY_CLIENT_ID`: deployment service principal application/client ID
   - `AZURE_TENANT_ID`: Entra tenant ID
   - `AZURE_SUBSCRIPTION_ID`: Azure subscription ID
   - `AZURE_RESOURCE_GROUP`: resource group name
   - `API_CLIENT_ID`: portal/API app registration application/client ID
   - `AZURE_PREFIX`: same resource prefix (optional; defaults to `pdfval`)
   - `ALERT_EMAIL`: alert recipient (optional)
3. Add the Entra Easy Auth client secret **Value** as the environment secret `ENTRA_CLIENT_SECRET`. The workflow writes it to a temporary parameter file and removes the file on exit. Deployment authentication uses GitHub OIDC, not this Entra secret.
4. Configure environment protection and required CI checks according to your release policy, then use **Actions > Deploy Azure > Run workflow**.

## Runtime, access boundary, and operations

- Easy Auth is the sole production authentication boundary. It protects `/api/session`, `/api/v1/*`, `/docs`, and `/openapi.json`. `/`, `/assets/*`, `/api/config`, `/health/live`, and `/health/ready` pass through without sign-in and contain no document data. Excluded paths bypass Easy Auth entirely and never receive the principal, so the server never decides access on them: `/` always serves the workspace shell, which stays blurred and inert under the sign-in card until the protected `/api/session` confirms an authorized user.
- Azure validates Entra tokens, strips caller-supplied `X-MS-CLIENT-PRINCIPAL`, and injects validated claims. FastAPI trusts this header only with `PDF_AUTH_MODE=easyauth`. Never expose the Python port through another proxy, ingress port, or direct production container mapping.
- Cookie-authenticated mutations require `X-Requested-With: PDFValidationPortal`; cross-site browser mutations are rejected. Bearer API calls do not need this header. The app does not accept unvalidated bearer tokens as a fallback.
- The API scales from 1–3 replicas at 0.5 vCPU/1 GiB. Worker executions scale to four, each 2 vCPU/4 GiB with a 900-second timeout. Maintenance runs every two minutes. Storage and registry access use managed identity; storage keys and public blob access are disabled.
- `/health/live` checks the process; `/health/ready` probes storage. Logs record request/document IDs and outcomes, not documents, original filenames, principal headers, tokens, or signed URLs. Log Analytics retention is 30 days. Alert rules cover processing/maintenance failures, job failures, and queue backlog. Queue backlog uses an hourly metric window because [QueueMessageCount is sampled hourly](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-storage-storageaccounts-queueservices-metrics).
- Uploaded PDFs and reports expire after 72 hours. Cleanup removes blobs, snapshots, and metadata. Storage versioning, soft delete, and backups are not enabled by these templates; enabling them changes physical retention.

## Azure smoke checks

1. Confirm Easy Auth is enabled with HTTPS required, the correct tenant issuer and audiences, and the configured callback. Anonymous `/api/session` and `/api/v1/documents` requests must return 401. Forged `X-MS-CLIENT-PRINCIPAL` headers must not grant access.
2. In a private window, open `/` and confirm the sign-in card covers the blurred workspace and no document data loads. Sign in from the card. Verify an assigned staff user lands in the uncovered workspace with the `Validation.User` role. Verify the session renews and expires as expected, sign-out returns to the signed-out page, and an unassigned user sees the access-needed page and cannot access documents.
3. Test machine tokens with `Validation.Run`; also verify rejection of foreign-tenant, wrong-audience, expired, and missing-role tokens. Test any delegated integrations with `Validation.Access`.
4. Upload pass/fail fixtures through the portal and Python client. Check per-profile results, report downloads, cross-principal 404 behavior, and cookie mutation CSRF protection.
5. Verify worker recovery, expiration and cleanup, SAS upload CORS, managed identity permissions, autoscaling, alert delivery, and representative multi-file load.

These checks require an actual Azure deployment. Local tests cannot prove Azure's cookie flow, header sanitization, token validation, or tenant configuration.

## Rollback

Redeploy the previous immutable image tag and its matching auth configuration. Preserve storage and in-flight job compatibility. Do not disable Easy Auth while the application trusts its validated headers. Resource-group deletion is not a rollback method.
