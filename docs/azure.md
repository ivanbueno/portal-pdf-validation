# Azure deployment with Entra Easy Auth

The portal delegates authentication to **Azure Container Apps Easy Auth**. Azure signs staff in, manages the session cookie, validates incoming Entra access tokens, and injects authenticated claims. FastAPI performs role checks and enforces document ownership using those claims. No MSAL library or token storage runs in the browser.

No Azure resources are provisioned until you run the deployment commands or the manual deployment workflow. Use a dedicated resource group with Container Apps, Container Registry, Storage, Managed Identity, Log Analytics, and Monitor resource providers registered.

## 1. Entra app registration

Use **one single-tenant Web app registration** for the portal/API:

- Application ID URI: `api://<API_CLIENT_ID>`; set `api.requestedAccessTokenVersion` to `2`.
- Web redirect URI: `https://<portal-host>/.auth/login/aad/callback`. This is a **Web** callback, not a SPA callback.
- Enable ID token issuance for the Easy Auth sign-in flow as described in Microsoft's [Container Apps Entra setup](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra).
- Create a client secret for Easy Auth. The secure Bicep parameter stores it in the Container App's `entra-client-secret` secret. It is never passed to the Python process or browser. Rotate it before expiry by redeploying with the new value.
- Add app role `Validation.User` with allowed member type **Users/Groups** (manifest: `User`). Assign authorized staff/groups to this role on the enterprise application. The portal requires this role for interactive users.
- Keep application role `Validation.Run` with allowed member type **Applications**. Assign it only to approved integration service principals.
- Keep delegated scope `Validation.Access` for approved clients calling on behalf of a user. This is separate from the browser's Easy Auth cookie flow.
- Enable enterprise application assignment requirements if appropriate for organizational policy; grant admin consent where required. Configure Conditional Access/MFA in Entra according to your organization.

Each approved machine integration has its own service principal and credentials or federation. It requests `api://<API_CLIENT_ID>/.default` via client credentials and sends `Authorization: Bearer ...`. Easy Auth validates the token; FastAPI requires `Validation.Run` from the injected claims.

### Migrating from the original configuration

Reuse the existing API registration, add the Web callback/client secret and `Validation.User` role, and assign staff/groups. `SPA_CLIENT_ID` / `PDF_SPA_CLIENT_ID` are no longer used; the separate SPA registration can be retired once no other applications depend on it. Existing delegated scope and application role assignments remain valid. Ownership keys still derive from tenant + user/application kind + object ID, so existing histories remain associated with the same principals.

## 2. Easy Auth boundary

The Bicep `Microsoft.App/containerApps/authConfigs` resource enables Microsoft Entra with the tenant-specific v2 issuer and only this API's audience. Unauthenticated protected requests return **401**, suitable for API callers. The public shell's sign-in button navigates to `/.auth/login/aad?post_login_redirect_uri=%2F`; sign-out uses `/.auth/logout`.

Only `/`, `/assets/*`, `/api/config`, `/health/live`, and `/health/ready` are excluded from the platform gate. `/api/session`, `/api/v1/*`, `/docs`, and `/openapi.json` remain protected. The public shell contains no document data. Token-store exposure is not enabled because the application never needs the user's tokens.

The application trusts `X-MS-CLIENT-PRINCIPAL` **only** with `PDF_AUTH_MODE=easyauth` in production (or explicit synthetic tests). Azure strips externally supplied principal headers and replaces them with validated claims. Standalone local servers do not trust these headers. Never expose the Python port through another proxy, additional ingress port, or production Docker mapping that bypasses Easy Auth. Deploy the auth configuration together with the app; do not run the production image directly on the internet. See [Microsoft's authentication architecture](https://learn.microsoft.com/en-us/azure/container-apps/authentication).

Cookie-authenticated mutations require `X-Requested-With: PDFValidationPortal`; cross-site browser requests are rejected and no cross-origin API CORS is enabled. The frontend supplies this header automatically. Bearer API calls remain supported without this browser header. The application does not attempt JWT verification or accept unsigned/unvalidated bearer tokens as a fallback.

## 3. Provision and deploy

Install Azure CLI and Bicep, authenticate, and select the intended subscription. Create a dedicated resource group in your chosen region. Deployment credentials need resource creation and scoped role-assignment permissions.

```sh
RESOURCE_GROUP=pdf-validation-prod
PREFIX=pdfval
TENANT_ID=<tenant-guid>
API_CLIENT_ID=<web-api-app-guid>
IMAGE_TAG=<immutable-release-id>

az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
  --template-file infra/foundation.bicep --parameters prefix="$PREFIX"
REGISTRY=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
  --query properties.outputs.registryName.value -o tsv)
az acr build --registry "$REGISTRY" --image "pdf-validation:$IMAGE_TAG" .
```

Supply `entraClientSecret` through a **temporary, permission-restricted parameter file**, not a literal command-line argument, committed file, or shell history. For example, Python can prompt without echoing the value and write the temporary file:

```sh
SECRET_PARAMS=$(mktemp)
chmod 600 "$SECRET_PARAMS"
trap 'rm -f "$SECRET_PARAMS"' EXIT
python3 - "$SECRET_PARAMS" <<'PY'
import getpass, json, sys
secret = getpass.getpass('Entra Easy Auth client secret: ')
if not secret:
    raise SystemExit('Client secret is required')
with open(sys.argv[1], 'w') as output:
    json.dump({'entraClientSecret': {'value': secret}}, output)
PY
az deployment group create --resource-group "$RESOURCE_GROUP" --name portal \
  --template-file infra/main.bicep --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" \
  tenantId="$TENANT_ID" apiClientId="$API_CLIENT_ID" "@$SECRET_PARAMS" \
  alertEmail=operations@example.com
ORIGIN=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name portal \
  --query properties.outputs.portalUrl.value -o tsv)
az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
  --template-file infra/foundation.bicep --parameters prefix="$PREFIX" portalOrigin="$ORIGIN"
```

Set the app registration's **Web** redirect URI to `$ORIGIN/.auth/login/aad/callback`. The final foundation deployment restricts Blob upload CORS to the portal origin. On later deployments, pass `portalOrigin="$ORIGIN"` to both foundation and main to preserve CORS during rollout. Use a lowercase alphanumeric prefix of 3–10 characters.

The built-in HTTPS hostname works without custom DNS. A custom domain, private networking, and API Management are not provisioned. Direct upload endpoints must be reachable by staff browsers; blob containers remain private and storage account keys/public blob access are disabled.

## 4. GitHub OIDC deployment

The manual `Deploy Azure` workflow builds in ACR and deploys the Git SHA image tag. Configure the deployment service principal's federated identity for the repository's `production` environment. Configure environment protection and required CI checks for the release process.

Environment **variables**: `AZURE_DEPLOY_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `API_CLIENT_ID`, optional `AZURE_PREFIX`, and `ALERT_EMAIL`.

Environment **secret**: `ENTRA_CLIENT_SECRET`. The workflow writes it into a temporary parameter file, passes the file to Bicep, and removes it on exit. Never put it in a GitHub variable or echo it. Deployment authentication itself still uses OIDC, not this secret.

Grant the deployment principal Contributor plus Role Based Access Control Administrator on the resource group (or equivalent custom permissions), including permission to run ACR builds. Allow time for role propagation on first deployment; do not enable registry admin credentials to work around it.

## Runtime, monitoring, and retention

API: 1–3 replicas at 0.5 vCPU/1 GiB. Workers: at most four executions, each 2 vCPU/4 GiB, 900-second execution timeout; the application controls three-attempt infrastructure retries. Maintenance runs every two minutes. Blob/Queue/Table and ACR access use managed identity; the Entra login client secret is separate and used only by Easy Auth.

`/health/live` checks the process; `/health/ready` probes storage. Logs contain request/document IDs and outcomes, not documents, original filenames, principal headers, tokens, or signed URLs. Log Analytics retention is 30 days. Configure alert email delivery for job failures, cleanup failures, and queue backlog.

The backlog alert uses an hourly window because [QueueMessageCount](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-storage-storageaccounts-queueservices-metrics) is sampled hourly. [Job Executions metrics](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-app-jobs-metrics) also monitor failed worker/maintenance executions.

Uploaded PDFs and reports expire after 72 hours; access revocation is immediate on expiry/deletion and scheduled cleanup removes blobs, snapshots, and metadata. Storage versioning/soft delete/backups are not enabled by these templates; adding them changes physical retention.

## Azure smoke checks

1. Confirm Easy Auth is enabled, HTTPS-only, with the correct issuer/audiences. Anonymous `/api/session` and `/api/v1/documents` must return 401. Externally forged `X-MS-CLIENT-PRINCIPAL` headers must not grant access.
2. Verify staff login through `/.auth/login/aad`, Web callback, `Validation.User` role assignment, session renewal/expiry, and sign-out. Test an unassigned user receives no document access.
3. Test valid machine tokens with `Validation.Run`, rejected foreign-tenant/wrong-audience/expired tokens, and rejected missing-role tokens. Validate existing delegated clients with `Validation.Access`.
4. Upload pass/fail fixtures through the portal and Python client; inspect per-profile results, report downloads, and cross-principal 404 behavior. Verify cookie mutation CSRF protection.
5. Interrupt a worker and verify recovery; check expiration, cleanup, SAS CORS, managed identity permissions, autoscaling, and alert delivery. Load-test representative multi-file selections.

These platform checks require an actual Azure deployment. Local tests validate the application's handling of synthetic Easy Auth claims; they cannot prove Azure's cookie flow, header sanitization, token validation, or tenant configuration.

## Rollback

Redeploy with the previous immutable image tag and its matching auth configuration. Do not deploy the old MSAL frontend with the new cookie-only integration or disable Easy Auth while the app trusts its headers. Preserve storage and in-flight job compatibility. Never use resource-group deletion as rollback.
