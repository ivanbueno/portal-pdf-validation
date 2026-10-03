# Manual Azure provisioning runbook with Entra Easy Auth

Use this runbook to provision a fresh PDF Validation Portal in Azure Container Apps without GitHub Actions. A Tier 1 operator runs the supplied Azure CLI commands and completes the Entra portal forms. The commands deploy the repository's Bicep templates to create and configure the Azure resources; do not create duplicate resources individually in the portal. For deployment through GitHub Actions, use [azure-ci.md](azure-ci.md).

Azure Container Apps Easy Auth handles staff sign-in, session cookies, and access-token validation. FastAPI authorizes validated claims and scopes documents to their owner. Complete the steps in order: Azure must create the app hostname before you can finish the Entra callback and browser upload CORS configuration.

**Completion criteria:** both deployments succeed, the resource checks match this runbook, readiness returns HTTP 200, protected endpoints reject anonymous requests, an assigned staff member can upload and validate a PDF, maintenance runs successfully, and operations receives a test alert if email notification is configured.

For an existing deployment, first follow the [worker environment migration guide](worker-isolation.md#existing-deployments). Premium ACR and four private endpoints add cost.

## 1. Collect the deployment details and confirm access

### 1.1 Record the approved values

Use a dedicated, otherwise unused resource group. Replace example values before running commands. Keep the following nonsecret information in the deployment ticket:

| Item | Example / instructions |
| --- | --- |
| Azure subscription ID | Subscription GUID supplied by the Azure administrator |
| Entra tenant ID | Directory GUID; must match the portal app registration |
| Resource group | `pdf-validation-prod` |
| Azure region | `westus2`; confirm Container Apps and required capacity are available in the approved region |
| Resource prefix | `pdfval`; use 3–10 lowercase letters/numbers, with a letter first |
| Portal registration name | `PDF Validation Portal` |
| Portal application (client) ID | Obtained in section 3; not an object ID or deployment identity ID |
| Release | Approved Git commit; its full SHA becomes the image tag |
| Alert recipient | An approved, monitored email address; leave empty only if email notifications are intentionally omitted |
| Authorized staff | Approved users/groups and one assigned test account |
| Negative test account | An unassigned test user in the same tenant |
| Credential owner | Team responsible for storing and rotating the Easy Auth secret |

Also record the generated registry name, storage name, portal URL, release image, test results, and secret **expiry date and vault reference** as they become available. Store secret values only in the organization's approved secret manager, never in this ticket or repository.

### 1.2 Confirm the required permissions

| Task | Required access / who handles it |
| --- | --- |
| Create the resource group | An Azure administrator or an operator with resource-group creation permission at subscription scope |
| Register resource providers | An administrator with provider-registration permission at subscription scope |
| Provision resources and run ACR builds | Operator with **Contributor** on the target resource group, or equivalent custom permissions including ACR builds |
| Create managed-identity custom roles and assignments | Operator with **User Access Administrator** on the target resource group, or equivalent role-definition and role-assignment permissions |
| Register/configure the portal application and assign staff | An authorized Entra application administrator/owner with the required directory permissions |
| Grant integration admin consent or configure Conditional Access | An appropriately privileged Entra administrator |

Azure resource permissions and Entra directory permissions are separate. Tier 1 can have the responsible administrator complete a prerequisite and record the result before continuing.

To have an Azure administrator grant the operator the resource-group roles:

1. Open [Azure portal](https://portal.azure.com) > **Resource groups** > the target group > **Access control (IAM)**.
2. Select **Add > Add role assignment**. Choose **Contributor** and select **Next**.
3. Under **Members**, choose **User, group, or service principal > Select members**. Select the approved operator or operations group.
4. Select **Review + assign** to finish.
5. Repeat for **User Access Administrator**. The administrator must ensure any assignment conditions permit the runtime roles listed in section 4.3.
6. Confirm both assignments are at this resource group. Allow time for propagation, then sign in again if necessary.

**Checkpoint:** the subscription, region, names, access, and responsible administrators are known. These templates create a public HTTPS API and a separate worker VNet with restricted egress and private endpoints. They do not configure custom domains or API Management. Worker custom roles require `Microsoft.Authorization/roleDefinitions/write`; Role Based Access Control Administrator alone is insufficient. Escalate requirements for those features before provisioning.

## 2. Prepare the command session and resource group

### 2.1 Open the repository and tools

Use Bash on an approved workstation or **Bash** in Azure Cloud Shell. These examples are not PowerShell commands. If using Cloud Shell, clone the approved repository there and change to its root first. Keep one session open so later steps retain the variables.

1. Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli), Git, Python 3, and curl if missing. ACR builds the image remotely, so Docker is not required.
2. Open Bash, change to the repository root, and check the tools/files:

   ```sh
   bash
   # Run subsequent commands in this Bash session, from the repository root.
   az version
   git --version
   python3 --version
   curl --version
   ls infra/foundation.bicep infra/main.bicep Dockerfile
   git status --short
   git rev-parse HEAD
   ```

3. Confirm the checkout is the approved release and `git status --short` is empty. ACR uploads the local build context; uncommitted changes would make a commit-tagged image misleading. Resolve unexpected changes with the release owner before building.
4. Install/update the Container Apps extension and prepare Bicep:

   ```sh
   az extension add --name containerapp --upgrade
   az bicep install
   az bicep version
   ```

### 2.2 Select the tenant and subscription

1. Set the values from the deployment ticket. Keep the quotes; replace every uppercase placeholder:

   ```sh
   SUBSCRIPTION_ID="YOUR_SUBSCRIPTION_ID"
   TENANT_ID="YOUR_DIRECTORY_TENANT_ID"
   RESOURCE_GROUP="pdf-validation-prod"
   LOCATION="westus2"
   PREFIX="pdfval"
   ALERT_EMAIL="operations@example.com"
   ```

   Set `ALERT_EMAIL=""` if the approved deployment intentionally has no email recipient. Alerts will still exist, but their action group will have no email receiver.
2. Sign in, select the subscription, and confirm the displayed IDs:

   ```sh
   az login --tenant "$TENANT_ID"
   az account set --subscription "$SUBSCRIPTION_ID"
   az account show --query '{subscription:name,id:id,tenantId:tenantId,user:user.name}' --output table
   ```

   If Cloud Shell is already signed in, still select and check the subscription. Stop if the displayed tenant/subscription differs from the ticket.

### 2.3 Create the empty resource group

1. Check whether the name already exists:

   ```sh
   az group exists --name "$RESOURCE_GROUP"
   ```

2. For a fresh deployment, expect `false`, then create it:

   ```sh
   az group create --name "$RESOURCE_GROUP" --location "$LOCATION" \
     --query '{name:name,location:location,state:properties.provisioningState}' --output table
   ```

3. If it already exists, open **Resource groups > the group > Overview** and confirm it is the approved empty bootstrap group or a partial deployment from this runbook. Do not use an unrelated occupied group or delete it to start over.
4. Confirm the location matches the ticket. The templates default to the resource group's location. Have the administrator complete section 1.2's IAM assignments now if the group was just created.

### 2.4 Register providers and compile templates

1. Run the following with an account authorized to register providers:

   ```sh
   for provider in \
     Microsoft.App Microsoft.Authorization Microsoft.ContainerRegistry \
     Microsoft.Insights Microsoft.ManagedIdentity Microsoft.Network Microsoft.OperationalInsights Microsoft.Storage
   do
     az provider register --namespace "$provider"
   done
   ```

2. Check every provider, including its name in the output:

   ```sh
   for provider in \
     Microsoft.App Microsoft.Authorization Microsoft.ContainerRegistry \
     Microsoft.Insights Microsoft.ManagedIdentity Microsoft.Network Microsoft.OperationalInsights Microsoft.Storage
   do
     az provider show --namespace "$provider" \
       --query '{provider:namespace,state:registrationState}' --output table
   done
   ```

   Wait several minutes and repeat the check for providers showing `Registering`. Continue only when all show `Registered`.
3. Compile both templates to temporary files. This validates Bicep syntax without provisioning resources:

   ```sh
   BUILD_DIR=$(mktemp -d)
   az bicep build --file infra/foundation.bicep --outfile "$BUILD_DIR/foundation.json"
   az bicep build --file infra/main.bicep --outfile "$BUILD_DIR/main.json"
   ```

**Checkpoint:** the correct group exists, required permissions are assigned, providers are registered, and both templates compile without errors. For any failed command, use section 9 before continuing; do not paste the remaining sections over an unresolved failure.

## 3. Create and configure the Entra portal/API registration

### 3.1 Register the application

1. Open [Microsoft Entra admin center](https://entra.microsoft.com). Confirm you are viewing the tenant recorded in section 1.
2. Go to **Identity > Applications > App registrations > New registration**.
3. Enter **Name:** `PDF Validation Portal`.
4. For **Supported account types**, choose **Accounts in this organizational directory only**.
5. Leave **Redirect URI** blank for now and select **Register**.
6. On **Overview**, copy **Directory (tenant) ID** and **Application (client) ID**. Confirm the tenant ID matches `$TENANT_ID`.
7. In the command session, set the new client ID:

   ```sh
   API_CLIENT_ID="YOUR_PORTAL_APPLICATION_CLIENT_ID"
   ```

8. Under **Owners**, add the approved application owner/administration group members as supported by your tenant's process. Record who maintains this registration.

### 3.2 Set the API identifier and delegated scope

1. In this registration, open **Expose an API**.
2. Next to **Application ID URI**, select **Add** (or **Edit**). Save `api://<APPLICATION_CLIENT_ID>`, substituting the client ID from section 3.1.
3. Open **Manifest**. Find the `api` object and set its `requestedAccessTokenVersion` property to the number `2`. Save; preserve the other manifest fields.
4. Return to **Expose an API > Add a scope**. Fill in:

   | Field | Value |
   | --- | --- |
   | Scope name | `Validation.Access` |
   | Who can consent | **Admins only** |
   | Admin consent display name | `Access PDF Validation Portal` |
   | Admin consent description | `Allows this application to access PDF Validation Portal on behalf of the signed-in user.` |
   | State | **Enabled** |

5. Select **Add scope**. Verify the resulting identifier is `api://<APPLICATION_CLIENT_ID>/Validation.Access`.
6. For an existing registration, edit the existing `Validation.Access` scope to **Admins only**, preserving its ID. Verify `api.oauth2PermissionScopes` contains an enabled entry with `value: Validation.Access` and `type: Admin`. Do not create a replacement scope or change unrelated permissions.

This delegated scope is for administrator-approved integrations acting on behalf of a user. Each delegated token must also contain the signed-in user's `Validation.User` role. Scope consent alone grants no API access. Staff browser sessions use Easy Auth and the staff app role below without needing an API scope.

### 3.3 Create both app roles

1. Open **App roles > Create app role**.
2. Create the staff role using the first column below; select **Apply**.
3. Select **Create app role** again and create the integration role using the second column.

   | Field | Staff role | Integration role |
   | --- | --- | --- |
   | Display name | `Validation User` | `Validation Run` |
   | Allowed member types | **Users/Groups** | **Applications** |
   | Value | `Validation.User` | `Validation.Run` |
   | Description | `Allows assigned staff to use the PDF Validation Portal.` | `Allows an approved integration application to run PDF validations.` |
   | Do you want to enable this app role? | Checked | Checked |

4. Confirm both roles are enabled. The **Value** strings are case-sensitive application settings; do not add spaces or substitute the display names.

### 3.4 Create the Easy Auth client secret

1. In the portal registration, open **Certificates & secrets > Client secrets > New client secret**.
2. Enter a description such as `Container Apps Easy Auth` and select the expiry required by your organization's rotation policy.
3. Select **Add** and immediately copy the secret **Value** to the approved secret manager. The **Secret ID** is not the value used for deployment.
4. Record the expiry date, credential owner, and vault reference. If the value is lost, create a replacement; it cannot be displayed again.

This credential is used by Easy Auth, stored as the Container App secret `entra-client-secret`, and is not passed into the Python container. It is separate from credentials an integration uses to obtain API tokens.

### 3.5 Assign staff access

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **Entra ID > Enterprise apps > All applications** (also labeled **Identity > Applications > Enterprise applications**).
2. Find **PDF Validation Portal**. On **Overview**, check its **Application ID** against section 3.1. Use the portal/API enterprise application, not a similarly named app, the GitHub deployment application or an integration client's application.
3. Open **Manage > Users and groups > Add user/group**.
4. Under **Users and groups**, select the approved staff user(s) or group, then select **Select**.
5. Under **Select a role**, choose **Validation User** (`Validation.User`), then select **Assign**.
6. Confirm the assignments appear with the correct role. Group assignment depends on tenant licensing; ask the Entra administrator if the group option is unavailable.
7. For an existing installation, first confirm approved machine integrations have `Validation.Run` as described in section 3.6. In the portal enterprise application, open **Manage > Properties**. **Assignment required?** is an enterprise-application setting; it is not on **App registrations**.
8. Set **Assignment required?** to **Yes**. Keep **Enabled for users to sign-in?** set to **Yes** so assigned staff can sign in.
9. Select **Save**. Reopen or refresh **Properties** and verify **Assignment required?** still shows **Yes**. Record the application ID and verified setting in the deployment ticket. The corresponding service-principal property is `appRoleAssignmentRequired: true`.
10. Repeat this verification for existing installations. Bicep and application deployments do not change this Entra setting.
11. Have the Entra administrator apply the approved consent and Conditional Access/MFA policy. Test assigned and unassigned users after deployment using section 7.2.

The application independently requires `Validation.User` for browser users and both `Validation.User` and `Validation.Access` for delegated API calls. Keep scope consent set to **Admins only**; consent is separate from user assignment. See [Microsoft's Assignment required reference](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/application-properties#assignment-required).

### 3.6 Authorize integrations, if required

Skip this subsection if no integration is being onboarded. Creating `Validation.Run` does not by itself authorize any client.

1. Confirm the integration has its own app registration and service principal in the API tenant.
2. Open the **integration's app registration** > **API permissions > Add a permission > My APIs > PDF Validation Portal**.
3. For a machine client, select **Application permissions > Validation.Run > Add permissions**.
4. Have an authorized Entra administrator select **Grant admin consent for <tenant>**. Verify the permission shows **Granted for <tenant>**.
5. For a delegated client, request **Delegated permissions > Validation.Access** instead and have an Entra administrator grant consent. Assign the signed-in user or their group **Validation User** on the portal enterprise application as in section 3.5. Obtain a fresh token and verify it contains both `scp: Validation.Access` and `roles: Validation.User`. The client's consent and the user's role assignment are separate requirements.

Application permissions are assigned through the client registration's API permissions; the staff **Users and groups** picker is not the procedure for granting a machine client `Validation.Run`. Microsoft's [app role assignment guide](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps) describes this distinction. If the API is missing from **My APIs**, verify the tenant, enabled role, and ownership of both registrations.

Use [azure-api.md](azure-api.md) for integration credentials, token requests, and upload/report calls. Its API setup also applies to this manual deployment: use the portal URL produced below. Machine clients request `api://<APPLICATION_CLIENT_ID>/.default` and need `Validation.Run`; they must not reuse the portal's Easy Auth secret.

**Checkpoint:** the ticket has the correct tenant/client IDs; the admin-only scope and two enabled roles exist; Assignment required is Yes; an assigned test user exists; the Easy Auth secret is stored securely with a rotation owner. The redirect URI remains pending until section 6.

## 4. Provision shared Azure resources and build the image

### 4.1 Deploy the foundation

1. For the first deployment, set the temporary CORS origin:

   ```sh
   ORIGIN="https://configure-after-first-deploy.invalid"
   ```

   This intentionally does not allow real browser uploads yet. For a retry after the portal URL is known, use that actual origin instead. Never reset an existing deployment's CORS to the placeholder.
2. From the repository root, run:

   ```sh
   az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
     --template-file infra/foundation.bicep \
     --parameters prefix="$PREFIX" portalOrigin="$ORIGIN" --output none
   az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
     --query properties.provisioningState --output tsv
   ```

3. Wait for the command to complete. The state must be `Succeeded`.
4. Retrieve generated names from the deployment outputs; do not guess the suffix:

   ```sh
   REGISTRY=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
     --query properties.outputs.registryName.value --output tsv)
   STORAGE=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
     --query properties.outputs.storageName.value --output tsv)
   REGISTRY_SERVER=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
     --query properties.outputs.registryServer.value --output tsv)
   printf 'Registry: %s\nStorage: %s\nRegistry server: %s\n' "$REGISTRY" "$STORAGE" "$REGISTRY_SERVER"
   ```

   All three values must be nonempty. Record them in the ticket.

### 4.2 Check the resources in Azure portal

Open **Resource groups > your group > Overview**, then refresh. Compare against this inventory. `<suffix>` is calculated by Bicep from the resource group ID.

| Resource | Expected name | Expected configuration / where to inspect |
| --- | --- | --- |
| User-assigned managed identity | `<prefix>-runtime` | **Overview** shows client ID and principal/object ID |
| Worker managed identity | `<prefix>-worker` | Separate client/principal IDs; never assigned the runtime roles |
| Container registry | `<prefix><suffix>` | Premium SKU (required for Private Link); **Access keys** shows admin user disabled |
| Storage account | `<prefix><suffix>` | StorageV2, Standard LRS; **Configuration** has HTTPS required, minimum TLS 1.2, blob anonymous access disabled, storage account key access disabled |
| Blob container | `documents` in the storage account | **Data storage > Containers**; private/no anonymous access |
| Queue | `validation` in the storage account | **Data storage > Queues** |
| Table | `validation` in the storage account | **Storage browser > Tables** |
| Log Analytics workspace | `<prefix>-logs` | 30-day workspace retention |
| Container Apps environment | `<prefix>-env` | API and maintenance; Log Analytics destination is `<prefix>-logs` |
| Worker environment/network | `<prefix>-worker-env`, `<prefix>-worker-vnet` | Internal workload-profiles environment; NSG denies unmatched outbound traffic; Blob, Queue, Table and ACR private endpoints |

The container, queue, and table are children of the storage account and may not appear as separate rows in the resource-group overview. The operator's management roles do not automatically allow browsing document data. If Storage browser returns a data-access error, do not enable account keys; use the deployment results and the runtime readiness check to verify provisioning, or ask the administrator for approved read access if needed.

### 4.3 Check runtime role assignments

1. Open the **storage account > Access control (IAM) > Role assignments**.
2. Filter/search for `<prefix>-runtime`. Confirm these four roles are assigned to that identity at the storage-account scope:
   - **Storage Blob Data Contributor**
   - **Storage Queue Data Contributor**
   - **Storage Table Data Contributor**
   - **Storage Blob Delegator**
3. Open the **container registry > Access control (IAM) > Role assignments** and verify **AcrPull** for `<prefix>-runtime` at the registry scope.
4. Verify the separate `<prefix>-worker` identity has only the [worker grants](worker-isolation.md#permissions) at container/queue/table/registry scope, with no inherited broad storage grants. Its Blob assignment must carry the ABAC condition.
5. If any are absent, inspect the `foundation` deployment error before proceeding. Bicep creates these assignments; correct deployment permissions and rerun rather than adding broader runtime roles.

### 4.4 Build and verify the release image

1. Recheck that the checkout is clean, then build the approved commit in ACR:

   ```sh
   git status --short
   IMAGE_TAG=$(git rev-parse HEAD)
   az acr build --registry "$REGISTRY" --image "pdf-validation:$IMAGE_TAG" .
   ```

2. Wait for the remote build to succeed. Record the ACR build/run ID from its output.
3. Confirm the image is present:

   ```sh
   az acr repository show --name "$REGISTRY" --image "pdf-validation:$IMAGE_TAG" \
     --query '{image:name,digest:digest}' --output table
   printf 'Release image: %s/pdf-validation:%s\n' "$REGISTRY_SERVER" "$IMAGE_TAG"
   ```

4. Record the full image reference and digest. Treat release tags as immutable: do not overwrite a tag with different image contents. If a successful build already exists for this commit during a retry, verify and reuse it.

**Checkpoint:** foundation deployment succeeded, resource names/settings and runtime roles match, and the release image exists in ACR. There is no working portal until the application deployment completes.

## 5. Deploy the API, Easy Auth, jobs, and alerts

### 5.1 Supply the secret and run the application deployment

The following block prompts without echoing the secret, stores it in a permission-restricted temporary file outside the build context, and deletes that file when the block exits, including on failure. Do not use shell tracing (`set -x`) or CLI debug output when handling credentials.

1. Confirm `$API_CLIENT_ID` is the portal registration ID and `$IMAGE_TAG` is the verified release tag. On first deployment, `$ORIGIN` is still the placeholder from section 4.1.
2. Copy the **entire block**, including the opening and closing parentheses, into the same Bash session:

   ```sh
   (
     set -euo pipefail
     set +x
     SECRET_PARAMS=$(mktemp)
     chmod 600 "$SECRET_PARAMS"
     trap 'rm -f "$SECRET_PARAMS"' EXIT
     python3 - "$SECRET_PARAMS" <<'PY'
   import getpass
   import json
   import sys

   secret = getpass.getpass('Entra Easy Auth client secret VALUE: ')
   if not secret:
       raise SystemExit('Client secret is required')
   with open(sys.argv[1], 'w') as output:
       json.dump({'entraClientSecret': {'value': secret}}, output)
   PY
     az deployment group create --resource-group "$RESOURCE_GROUP" --name portal \
       --template-file infra/main.bicep \
       --parameters prefix="$PREFIX" imageTag="$IMAGE_TAG" tenantId="$TENANT_ID" \
       apiClientId="$API_CLIENT_ID" alertEmail="$ALERT_EMAIL" portalOrigin="$ORIGIN" \
       "@$SECRET_PARAMS" --output none
   )
   ```

3. When prompted, enter the secret **Value** from the approved secret manager and press Enter. It will not display as you type/paste.
4. Wait for deployment to finish. If the block fails, stop and inspect the error using section 9; do not read an old deployment's URL as proof of success.
5. Verify the state and obtain the new URL:

   ```sh
   az deployment group show --resource-group "$RESOURCE_GROUP" --name portal \
     --query properties.provisioningState --output tsv
   ORIGIN=$(az deployment group show --resource-group "$RESOURCE_GROUP" --name portal \
     --query properties.outputs.portalUrl.value --output tsv)
   printf 'Portal origin: %s\nWeb callback: %s/.auth/login/aad/callback\n' "$ORIGIN" "$ORIGIN"
   ```

   Expect `Succeeded` and an `https://...azurecontainerapps.io` URL. Record it without a trailing slash.

### 5.2 Verify application resources

In **Resource groups > your group > Overview**, confirm the following additional resources. The template also redeploys the foundation, which is why every application deployment must receive the correct `portalOrigin`.

| Resource | Expected configuration |
| --- | --- |
| `<prefix>-api` Container App | External ingress, HTTPS required, target port 8000, single active revision; image tag from section 4.4; 0.5 vCPU / 1 GiB; 1–3 replicas |
| `<prefix>-worker` Container Apps job | Event trigger on storage queue `validation`; `pdf-worker` command; 2 vCPU / 4 GiB; 900-second timeout; 0–4 executions, 10-second polling, no platform retries |
| `<prefix>-maintenance` Container Apps job | Schedule `*/2 * * * *` (every two minutes, UTC); `pdf-maintenance` command; 0.5 vCPU / 1 GiB; 600-second timeout; one platform retry |
| `<prefix>-alerts` action group | Email receiver matches `$ALERT_EMAIL`, or empty if intentionally omitted |
| `<prefix>-processing-failures` alert | Processing/maintenance log errors, severity 2, evaluated every 5 minutes over a 15-minute window |
| `<prefix>-queue-backlog` alert | Queue message count average above 1,000 over a one-hour window, evaluated every 5 minutes |
| `<prefix>-worker-failed` and `<prefix>-maintenance-failed` alerts | Failed job executions, severity 2, five-minute window |

Open each app/job's **Identity** and registry/container settings: API and maintenance use `<prefix>-runtime`; worker, its image pull and its scaler use only `<prefix>-worker`. All use the same release image. Worker must run in `<prefix>-worker-env`. For the API, confirm environment variables `PDF_ENVIRONMENT=production`, `PDF_AUTH_MODE=easyauth`, the expected `PDF_TENANT_ID`, `PDF_AUDIENCE` (client ID), `PDF_STORAGE_ACCOUNT`, and `AZURE_CLIENT_ID` (runtime identity client ID). The jobs share the application settings, but the worker's `AZURE_CLIENT_ID` must be the worker identity's client ID.

### 5.3 Check Easy Auth configuration

1. Open `<prefix>-api` > **Security > Authentication**. Verify authentication is enabled with Microsoft as the identity provider and the existing portal registration selected. Do not create another registration from this screen.
2. Inspect the full configuration if needed with this read-only command from the [Container Apps authentication CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/auth?view=azure-cli-latest):

   ```sh
   az containerapp auth show --resource-group "$RESOURCE_GROUP" --name "$PREFIX-api" --output json
   ```

3. Compare it with the template:

   | Setting | Expected value |
   | --- | --- |
   | Platform enabled | `true` |
   | Unauthenticated client action | `Return401` |
   | Require HTTPS | `true` |
   | Microsoft provider enabled | `true` |
   | Registration client ID | `$API_CLIENT_ID` |
   | Client secret setting name | `entra-client-secret` |
   | Issuer in public Azure | `https://login.microsoftonline.com/<TENANT_ID>/v2.0` |
   | Allowed audiences | `<API_CLIENT_ID>` and `api://<API_CLIENT_ID>` |
   | Excluded paths | `/`, `/assets/*`, `/api/config`, `/health/live`, `/health/ready` |

The token store is not enabled by the template. Protected routes include `/api/session`, `/api/v1/*`, `/docs`, and `/openapi.json`. Excluded paths bypass Easy Auth and do not receive the principal: `/` always serves a public workspace shell, which stays blurred and inert until the protected session check authorizes the user. The shell contains no document data.

**Checkpoint:** the app and both jobs use the same image; the worker has its own identity and environment. Alerts exist, Easy Auth matches the table, and the portal origin has been recorded. Do not invite users yet; the callback and CORS still need completion.

## 6. Finish the Entra callback and Blob upload CORS

### 6.1 Add the Web callback

1. In Entra **App registrations > PDF Validation Portal**, verify the application ID again.
2. Open **Authentication > Add a platform > Web**. In newer portal layouts, use **Authentication (Preview) > Add Redirect URI > Web**.
3. Paste the complete callback printed in section 5.1:

   ```text
   https://<CONTAINER_APP_HOSTNAME>/.auth/login/aad/callback
   ```

4. Select **Configure**/**Save**. Verify it appears under the **Web** platform, not SPA or public client.
5. Under the authentication settings' **Implicit grant and hybrid flows**, enable **ID tokens (used for implicit and hybrid flows)** and save, as described in Microsoft's [Container Apps Entra registration instructions](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra#option-2-use-an-existing-registration-created-separately). The newer authentication screen places this on its **Settings** tab.

### 6.2 Replace the placeholder CORS origin

1. Verify `$ORIGIN` is the actual portal origin from section 5.1, including `https://` and excluding any path or trailing slash.
2. Redeploy the foundation with it:

   ```sh
   az deployment group create --resource-group "$RESOURCE_GROUP" --name foundation \
     --template-file infra/foundation.bicep \
     --parameters prefix="$PREFIX" portalOrigin="$ORIGIN" --output none
   az deployment group show --resource-group "$RESOURCE_GROUP" --name foundation \
     --query properties.provisioningState --output tsv
   ```

3. Expect `Succeeded`. In Azure portal, open the **storage account > Resource sharing (CORS) > Blob service** and confirm:

   | Field | Expected value |
   | --- | --- |
   | Allowed origins | The exact portal origin; no placeholder or wildcard |
   | Allowed methods | `PUT`, `OPTIONS` |
   | Allowed headers | `*` |
   | Exposed headers | `ETag` |
   | Max age | `3600` seconds |

**Checkpoint:** the Web callback matches the deployed hostname and Blob CORS allows that origin. Keep `portalOrigin="$ORIGIN"` in both foundation and application redeployments. If the hostname ever changes, update both settings before testing uploads again.

## 7. Run acceptance checks

Record pass/fail, time, release image, and any relevant request/document IDs in the ticket. Use non-sensitive test PDFs. A successful infrastructure deployment alone does not prove browser sign-in or job processing works.

### 7.1 Check health and anonymous access

1. Run:

   ```sh
   curl --fail --silent --show-error "$ORIGIN/health/live"
   curl --fail --silent --show-error --retry 12 --retry-delay 10 --retry-all-errors \
     "$ORIGIN/health/ready"
   ```

   Expect `{"status":"ok"}` and `{"status":"ready"}` with HTTP 200. Readiness probes Blob, Queue, and Table Storage using the runtime identity.
2. Without cookies or tokens, check protected paths:

   ```sh
   for route in /api/session /api/v1/documents /docs /openapi.json
   do
     printf '%s: ' "$route"
     curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$ORIGIN$route"
   done
   ```

   Each must return **401**. Do not use `curl --fail` for these expected failures.
3. Confirm a caller-supplied principal header cannot bypass authentication:

   ```sh
   FORGED_PRINCIPAL=$(python3 - "$TENANT_ID" <<'PY'
   import base64
   import json
   import sys
   import uuid

   principal = {
       'auth_typ': 'aad',
       'name_typ': 'name',
       'role_typ': 'roles',
       'claims': [
           {'typ': 'tid', 'val': sys.argv[1]},
           {'typ': 'oid', 'val': str(uuid.uuid4())},
           {'typ': 'roles', 'val': 'Validation.User'},
       ],
   }
   print(base64.b64encode(json.dumps(principal).encode()).decode())
   PY
   )
   curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
     --header "X-MS-CLIENT-PRINCIPAL: $FORGED_PRINCIPAL" "$ORIGIN/api/session"
   unset FORGED_PRINCIPAL
   ```

   Expect **401**. If any anonymous/forged request succeeds, stop handoff and escalate the authentication configuration.

### 7.2 Check assigned and unassigned browser users

1. Open a private browser window and navigate to `$ORIGIN/`.
2. Verify the sign-in card covers the blurred workspace and no document data is visible.
3. Select the sign-in button. It should start at `/.auth/login/aad` and take you to the correct organization's sign-in page.
4. Sign in as the assigned test user; complete MFA if required. Expect the uncovered workspace.
5. Refresh the page to confirm the session remains usable. In browser developer tools, `/api/session` should return 200. Do not copy session cookies or principal headers into the ticket.
6. Sign out. Expect return to `/?signed-out` with the workspace covered. Refresh and confirm documents are no longer available.
7. Reopen the portal enterprise application's **Properties** and confirm **Assignment required? = Yes**. In a separate private browser session, sign in as the unassigned **non-administrator** test user. Expect Entra to block sign-in. Global Administrators are exempt from Entra's assignment requirement, so do not use one for this negative test. If the ordinary unassigned user can sign in, recheck the tenant, application ID and saved setting from section 3.5; the application must still deny document access without `Validation.User`.
8. Have the identity owner validate renewal/expiry behavior against the organization's session policy; record any longer-running checks with an owner and due date.

### 7.3 Check upload, processing, reports, and ownership

1. Sign back in as the assigned user.
2. Upload `tests/fixtures/ua-pass.pdf` and `tests/fixtures/ua-fail.pdf` from the approved checkout, using both validation profiles.
3. Confirm uploads complete without Blob CORS errors and progress advances through queued/running to results. Small files may move too quickly to display every intermediate state.
4. Open each result. Compare pass/fail findings with the release's expected fixture results; a validation **Fail** is a document result, while an infrastructure **Error** needs investigation. Verify both profile results are present.
5. Open the PDF preview and download an available report. Confirm the report corresponds to the selected test document.
6. With a second assigned user in another browser session, verify the first user's documents are absent. An engineer can verify direct requests for the other user's document return 404 using the documented [API endpoints](api.md).
7. Delete a test document through the portal. Confirm it disappears and is no longer accessible. Leave a separate test document for the retention check in section 8 if required.
8. If integrations are in scope, follow [azure-api.md](azure-api.md) to obtain a fresh token and complete upload → submit → poll → report download. Have the integration owner verify rejection of wrong-tenant, wrong-audience, expired, and missing-role tokens; for delegated access, verify both the user role and scope are required (scope-only and role-only bearer requests return 403).

Cookie-authenticated changes require `X-Requested-With: PDFValidationPortal`, which the UI sends. Bearer API clients do not need that header. The application/security owner should verify cookie mutation rejection without it and under a cross-site request before production acceptance; record the result or an explicit outstanding acceptance item.

### 7.4 Check jobs, logs, and alert delivery

1. In Azure portal, open `<prefix>-worker` > **Execution history**. Confirm executions occurred for the test uploads and inspect any failures.
2. Open `<prefix>-maintenance` > **Execution history**. Wait for at least one scheduled execution (every two minutes) and confirm it succeeds.
3. The equivalent read-only checks are:

   ```sh
   az containerapp job execution list --resource-group "$RESOURCE_GROUP" \
     --name "$PREFIX-worker" --output table
   az containerapp job execution list --resource-group "$RESOURCE_GROUP" \
     --name "$PREFIX-maintenance" --output table
   ```

   An empty worker history before any upload is normal. A platform-successful execution does not alone prove the PDF passed: also check the portal result. See the [job execution CLI reference](https://learn.microsoft.com/en-us/cli/azure/containerapp/job/execution?view=azure-cli-latest).
4. Open `<prefix>-logs` > **Logs** and run:

   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(30m)
   | project TimeGenerated, ContainerAppName_s, Log_s
   | order by TimeGenerated desc
   | take 100
   ```

   Allow for ingestion delay. Look for recent application activity and `maintenance_finished` events with `failures` equal to `0`. Logs should contain IDs/outcomes rather than document content, original filenames, tokens, principal headers, or signed URLs.
5. Open **Azure Monitor > Alerts > Alert rules**, filter to the resource group, and confirm all four alert rules from section 5.2 are enabled and linked to `<prefix>-alerts`.
6. If email is configured, open **Azure Monitor > Alerts > Action groups > <prefix>-alerts > Test**. Select a test notification type and the email receiver, send the test, and confirm the operations recipient receives it. Record the result. This checks delivery; it does not prove each alert condition will fire. See Microsoft's [action group testing instructions](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups#test-an-action-group-in-the-azure-portal).

**Checkpoint:** all required checks pass. Track recovery, representative multi-file load, retention, session-policy, and deeper security tests with the application/identity owner where Tier 1 cannot execute them. Do not mark an unperformed check as passed. Azure's real cookie flow, header sanitization, and token validation cannot be proven by local tests.

## 8. Record the handoff and ongoing operating requirements

Attach this checklist to the deployment ticket:

- [ ] Subscription/tenant, resource group, region, prefix, portal registration client ID, and resource names recorded.
- [ ] Approved Git commit, image tag/digest, ACR build ID, and successful deployment names (`foundation`, `portal`) recorded.
- [ ] Portal URL and exact Web callback recorded; Blob CORS matches.
- [ ] Runtime identity assignments and Easy Auth configuration verified.
- [ ] Assigned/unassigned sign-in, anonymous rejection, upload, reports, ownership, and deletion checks recorded.
- [ ] Worker and maintenance execution results recorded; alert test delivered or email omission documented.
- [ ] Secret vault reference, expiry, owner, and rotation due date recorded; no secret value included.
- [ ] Remaining acceptance checks have a named owner and due date; release owner has assessed them before staff rollout.
- [ ] Previous compatible image/configuration and rollback owner identified for subsequent releases.

Uploaded PDFs and reports become inaccessible after **72 hours**. The scheduled maintenance job removes expired blobs, snapshots, and metadata. For retention acceptance, leave a non-sensitive test document and verify it is inaccessible after expiry and physically cleaned up after maintenance; an administrator with approved data access can verify deletion. Do not change production retention settings simply to accelerate this test.

The templates do not enable storage versioning, soft delete, or backups. Enabling them changes physical retention and requires a retention-policy review. Log Analytics retention is **30 days**. Queue backlog alerting uses an hourly metric window because [QueueMessageCount is sampled hourly](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-storage-storageaccounts-queueservices-metrics).

Easy Auth must remain the sole public authentication boundary. Do not expose port 8000 through an additional ingress/proxy, disable Easy Auth, or enable local development identity settings in Azure.

## 9. Troubleshooting and safe restart points

### 9.1 Inspect a failed deployment

1. In Azure portal, open **Resource groups > your group > Deployments**.
2. Open `foundation` or `portal`, select the failed operation, and record its error code, resource name, timestamp, and correlation ID. For a failed nested `foundation` deployment, open that deployment's operation details too.
3. Read the same information from the CLI if needed:

   ```sh
   DEPLOYMENT_NAME="portal"  # Use foundation when that deployment failed.
   az deployment operation group list --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" \
     --query "[?properties.provisioningState=='Failed'].{resource:properties.targetResource.resourceName,error:properties.statusMessage}" \
     --output json
   ```

4. Resolve the specific error, then rerun the failed stage with the same group/prefix and verified parameters. These are incremental deployments; do not delete resources to retry.

| Symptom | Tier 1 checks / next action |
| --- | --- |
| `AuthorizationFailed` on resource creation or ACR build | Confirm `az account show` and operator Contributor/custom permissions at the target group. Ask Azure administrator to fix the missing action/scope. |
| Role-assignment failure | Verify Role Based Access Control Administrator and any assignment conditions. Allow propagation before retrying foundation. |
| Provider not registered | Repeat section 2.4 for the named provider using a subscription-authorized account. |
| Policy denial, quota, or region capacity failure | Record the policy/quota/resource error and escalate to the Azure administrator. Do not switch subscriptions/regions or relax policy independently. |
| Registry/storage name conflict | Check whether the approved prefix/group were already used. Escalate before changing names; a different prefix creates a different resource set. |
| ACR build fails | Read the failing build step. Confirm clean checkout and approved source. Dependency download/build errors go to the release owner; do not deploy a missing image tag. |
| Image pull failure / revision not ready | Confirm the image exists, registry identity is `<prefix>-runtime`, and that identity has AcrPull. Check the app's system logs; retry after role propagation if appropriate. Do not enable registry admin credentials. |
| `/health/ready` returns 503 | Verify storage names, all four runtime data roles, identity client ID, and storage connectivity. Check app logs. Do not introduce account keys as a workaround. |
| `AADSTS50011` / redirect mismatch | Compare the exact hostname and `/.auth/login/aad/callback` path with the registration's Web redirect URI. Save the corrected URI and retry a private session. |
| Sign-in reports `id_token` response type is not enabled | Check the ID tokens setting in section 6.1 and save it. |
| `invalid_client` or secret-related sign-in failure | Confirm the supplied credential is the portal registration's secret Value, is unexpired, and matches the client ID. Redeploy section 5 with a valid secret. |
| Assigned user sees access needed / 403 | Verify the enterprise app's Application ID, enabled `Validation.User` role, and actual user/group assignment. Sign out and start a fresh session after changes. Ask the identity administrator about consent or Conditional Access failures. |
| Upload fails with CORS error | Compare the browser's origin with Blob-service CORS. Redeploy foundation with the exact `$ORIGIN`. A later main deployment without `portalOrigin` can restore the placeholder. |
| Upload succeeds but document stays queued | Inspect worker execution history, queue scaler account/queue/identity, registry pulls, and runtime queue permissions. Escalate persistent failures with document ID and timestamps. |
| No alert email | Confirm `ALERT_EMAIL` was nonempty, action group receiver is correct, and its test succeeds. Delivery success is separate from triggering the alert. |
| Storage portal cannot browse data | Operator management permissions are separate from storage data permissions. Use runtime readiness or request approved data access; do not enable shared keys. |

For API/system logs during an incident:

```sh
az containerapp logs show --resource-group "$RESOURCE_GROUP" --name "$PREFIX-api" \
  --type system --tail 50
az containerapp logs show --resource-group "$RESOURCE_GROUP" --name "$PREFIX-api" \
  --type console --tail 50
```

Share only relevant, redacted diagnostics with the responsible administrator. Never attach secrets, tokens, session cookies, principal headers, PDF content, or SAS upload URLs.

### 9.2 Resume after the shell closes

1. Return to the same approved repository/release. Repeat section 2.2 to set nonsecret variables and select the correct account.
2. Restore `$API_CLIENT_ID` and the approved `$IMAGE_TAG` from the ticket.
3. Recover `$REGISTRY`, `$STORAGE`, and `$REGISTRY_SERVER` using section 4.1's output commands once foundation is successful.
4. If the app already exists, recover its origin:

   ```sh
   FQDN=$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "$PREFIX-api" \
     --query properties.configuration.ingress.fqdn --output tsv)
   if [ -n "$FQDN" ]; then
     ORIGIN="https://$FQDN"
     printf 'Recovered portal origin: %s\n' "$ORIGIN"
   fi
   ```

5. If the command fails, check the account/group/app name and deployment status. Use the placeholder only when you have confirmed the app has never been created.
6. Resume from the failed stage. Section 5 will prompt for the secret again; never recover it from shell history. If a interrupted session left a temporary credential file, remove that specific file according to the workstation's credential-handling procedure.

## 10. Subsequent releases, secret rotation, and rollback

### 10.1 Deploy another release manually

1. Record the current image and configuration as the rollback baseline. Check out the next approved release with a clean working tree.
2. Restore the deployment variables and actual portal origin using section 9.2. Do not use the first-deploy placeholder.
3. Compile the approved templates (section 2.4), then deploy foundation and build the new immutable image (section 4).
4. Deploy section 5 with the current valid Easy Auth secret and actual `portalOrigin`. This updates the API and both jobs together.
5. Reapply/verify CORS (section 6.2), then rerun the applicable acceptance checks in section 7 and record the release.

### 10.2 Rotate the Easy Auth secret before expiry

1. Create a new secret on the **same portal registration** using section 3.4. Keep the existing secret valid during the change.
2. Store the new value and expiry in the approved secret manager.
3. Using the current approved image tag, matching templates, and actual portal origin, repeat section 5 and enter the new secret Value.
4. Verify readiness, a fresh private-window sign-in, sign-out, and assigned-user access.
5. After successful validation and according to the rotation policy, remove the old credential from the Entra registration. Update the credential owner/expiry record and any authorized deployment system's copy of the secret.

### 10.3 Roll back a release

1. Have the release owner identify the previous compatible image tag and matching infrastructure/auth configuration. Confirm storage/schema and in-flight job compatibility before proceeding.
2. Verify that image still exists in ACR. Use the matching approved templates, keep the same resource group/prefix and actual portal origin, and set `IMAGE_TAG` to the rollback tag.
3. Repeat section 5 with a **currently valid** Easy Auth secret. An expired old secret is not part of rollback.
4. Verify CORS, health, sign-in, upload/results, and both jobs using sections 6–7. Existing running job executions can still use the earlier image until they finish; check execution history before declaring recovery.
5. Record the restored image and incident outcome. Do not disable Easy Auth or delete the resource group as a rollback method.

### 10.4 Optional: move future deployments to GitHub Actions

Follow [azure-ci.md](azure-ci.md) for the dedicated deployment service principal, GitHub OIDC trust, and `production` environment setup. Reuse this resource group, prefix, portal registration, and Easy Auth secret; do not create a second portal registration. Configure the workflow's variables from the recorded deployment values and store the Easy Auth secret as `ENTRA_CLIENT_SECRET`. Deployment authentication uses OIDC, not that secret. Choose one release owner/process so manual and workflow deployments do not run concurrently.
