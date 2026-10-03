# Fresh Azure deployment through GitHub Actions

This guide provisions and deploys the PDF Validation Portal using the repository's **Deploy Azure** workflow at `.github/workflows/deploy.yml`. Run that workflow for every provisioning and application deployment; do not deploy the Bicep templates or build/push the image by hand. A few one-time prerequisites must be created outside the workflow: the Entra app registration, GitHub OIDC trust, and GitHub environment settings.

The workflow provisions the shared Azure foundation, builds the image in Azure Container Registry, deploys the Container App with Entra Easy Auth, configures worker and maintenance jobs and alerts, sets Blob Storage CORS, and checks readiness. The first run creates the portal hostname. You then add that hostname as the Entra Web callback before staff sign in.

## 1. Choose names and collect identifiers

Choose a dedicated Azure subscription and environment/project tokens. The defaults are `AZURE_ENV=prod` and `AZURE_PROJECT=pdfportal`. Environment tokens allow 1–5 lowercase letters/digits; project tokens allow 1–10. Both start with a letter. These limits keep the current storage and job names within Azure's length limits. Names include a function where it distinguishes purpose, such as `api`, `worker` or `blob`. Each type/function has one instance in this deployment, so instance numbers are omitted. See the [naming inventory and exceptions](azure-naming.md). Record:

- Azure subscription ID
- Microsoft Entra tenant ID
- GitHub repository owner and repository name
- Alert email address, if desired

From the repository root, preview the names before setting up the deployment. Substitute your chosen tokens if they differ from the defaults:

```sh
python3 scripts/azure_names.py --env prod --project pdfportal
```

The workflow and Bicep modules share [`infra/names.json`](../infra/names.json); the workflow uses the helper's `--format shell` output for resource lookups and deployment names. Keep this file and the helper in the approved release checkout.

## 2. Prepare the subscription and resource-group names

The subscription-scope foundation creates four groups on the first workflow run. With `AZURE_ENV=prod` and `AZURE_PROJECT=pdfportal`, the layout is:

| Resource group | Resources |
| --- | --- |
| `prod-pdfportal-admin-rg` | Runtime and worker managed identities, Premium Container Registry, Log Analytics, action group and alerts |
| `prod-pdfportal-net-rg` | Worker VNet, subnets, NSG, four private endpoints and linked private DNS zones |
| `prod-pdfportal-app-rg` | API and worker Container Apps environments, API Container App, worker and maintenance jobs, Easy Auth |
| `prod-pdfportal-data-rg` | Storage account, Blob container, queue, table, storage role assignments and worker custom role definitions |

Azure may also create a service-managed infrastructure resource group for the VNet-integrated Container Apps environment. Azure owns that group's lifecycle; the four groups above contain the resources declared by this repository. See [Container Apps networking](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks).

Set `AZURE_LOCATION` to the approved Azure region (for example `westus2`). The workflow uses it for the deployment record and every regional resource. Keep the same environment, project and region on subsequent runs. This layout assumes a fresh deployment; it does not move resources from a previous single-group installation.

```sh
az login
SUBSCRIPTION_ID="YOUR_SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"
```

The deployment identity needs permission to create subscription deployments and resource groups, deploy into all four groups, build images in ACR, and create role definitions/assignments in admin and data. On a dedicated subscription, **Contributor** plus **User Access Administrator** at subscription scope is a straightforward bootstrap setup. For narrower access, an administrator can precreate the four groups, grant Contributor on each and User Access Administrator on admin/data, and supply a subscription-scoped custom role permitting deployment operations and resource-group reads/writes. Resource-group-only grants are insufficient for these subscription-scope entry points. Worker custom roles require `Microsoft.Authorization/roleDefinitions/write`; Role Based Access Control Administrator alone is insufficient. Runtime identities retain only the resource-scoped grants declared in Bicep.

Allow the following resource providers to register. An administrator may register them ahead of time if the deployment identity cannot.

```sh
for provider in \
  Microsoft.App \
  Microsoft.Authorization \
  Microsoft.ContainerRegistry \
  Microsoft.Insights \
  Microsoft.ManagedIdentity \
  Microsoft.Network \
  Microsoft.OperationalInsights \
  Microsoft.Storage
do
  az provider register --namespace "$provider"
done

for provider in \
  Microsoft.App \
  Microsoft.Authorization \
  Microsoft.ContainerRegistry \
  Microsoft.Insights \
  Microsoft.ManagedIdentity \
  Microsoft.Network \
  Microsoft.OperationalInsights \
  Microsoft.Storage
do
  az provider show --namespace "$provider" \
    --query registrationState --output tsv
done
```

## 3. Register the portal/API in Entra

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **Identity > Applications > App registrations > New registration**.
2. Name it `PDF Validation Portal`, select **Accounts in this organizational directory only**, and leave redirect URI empty for now. Create it and record its **Directory (tenant) ID** and **Application (client) ID**.
3. Under **Expose an API**, set the Application ID URI to `api://<APPLICATION_CLIENT_ID>`. Set `api.requestedAccessTokenVersion` to `2` in the app manifest.
4. Add an enabled delegated scope named `Validation.Access` with **Who can consent: Admins only** for approved integrations that call on behalf of a user. Delegated tokens must include both this scope and the signed-in user's `Validation.User` role.

> In the portal/API app registration named **PDF Validation Portal**, open **Expose an API**. Save `api://<APPLICATION_CLIENT_ID>` as the Application ID URI if it is not already configured. Select **Add a scope**, enter `Validation.Access`, set **Who can consent** to **Admins only**, and supply the admin consent display name and description. For example: “Access PDF Validation Portal on behalf of the signed-in user.” Leave the scope enabled and save it.
>
> The scope identifier is `api://<APPLICATION_CLIENT_ID>/Validation.Access`. In an integration's registration, select **API permissions > Add a permission > My APIs > PDF Validation Portal > Delegated permissions** and request that scope. An Entra administrator must grant consent on the integration registration. Each signed-in user also needs the portal's `Validation.User` role; client consent does not assign that role.

5. Add these enabled app roles under **App roles**:
   - `Validation.User`, allowed member types **Users/Groups**
   - `Validation.Run`, allowed member types **Applications**

For each role, create an enabled app role in the PDF Validation Portal app registration. In App roles → Create app role, set:

| Field | Validation.User | Validation.Run |
| --- | --- | --- |
| Display name | Validation User | Validation Run |
| Allowed member types | Users/Groups | Applications |
| Value | `Validation.User` | `Validation.Run` |
| Description | Allows assigned staff to use the PDF Validation Portal. | Allows an approved integration application to run PDF validations. |
| Do you want to enable this app role? | Yes | Yes |

The Value is the exact role string the application checks in the validated claims. Assign Validation.User to staff or groups, and `Validation.Run` only to approved integration service principals.

6. Under **Certificates & secrets**, create a client secret for Easy Auth. Copy the secret **Value**; GitHub will store it in step 6. Choose an expiry that supports your rotation policy.
7. Assign approved users and integrations, then require assignment on the portal's enterprise application using the steps below.

### Assign users and require assignment

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **Entra ID > Enterprise apps > All applications** (also labeled **Identity > Applications > Enterprise applications**).
2. Find **PDF Validation Portal**. On **Overview**, verify its **Application ID** matches the portal/API **Application (client) ID** recorded above. Use the portal's enterprise application, not the GitHub deployment application or an integration client's application.
3. Open **Manage > Users and groups > Add user/group**. Select the approved staff user or group, choose the **Validation User** role (`Validation.User`), then select **Assign**. Repeat as needed and verify the assignments appear. Group assignment depends on tenant licensing.
4. For an existing installation, first confirm approved machine integrations have `Validation.Run` through the [client permission setup](azure-api.md#3-add-the-api-application-permission). In the portal enterprise application, open **Manage > Properties**. This setting belongs to the enterprise application (service principal), not the **App registrations** page.
5. Set **Assignment required?** to **Yes**. Keep **Enabled for users to sign-in?** set to **Yes** so assigned staff can sign in.
6. Select **Save**. Reopen or refresh **Properties** and confirm **Assignment required?** still shows **Yes**. Record the application ID and verified setting in the deployment record.
7. Apply these steps to existing installations as well as new ones. The GitHub deployment workflow and Bicep templates do not set this Entra property.

For machine integrations, grant `Validation.Run` through the integration client's **API permissions** and administrator consent as described in [external API client setup](azure-api.md#3-add-the-api-application-permission).

Keep the `Validation.Access` scope set to **Admins only**. Delegated integrations need administrator consent on the client application **and** a `Validation.User` assignment for the signed-in user. The application checks both permissions; consent does not replace the user assignment. Apply the approved Conditional Access/MFA policy to the portal enterprise application.

After deployment, test with a fresh browser session: an assigned staff user should reach the workspace, while an unassigned **non-administrator** should be blocked by Entra. Use a non-administrator for the negative test because Global Administrators are exempt from Entra's assignment requirement; application role checks still apply. See [Microsoft's Assignment required reference](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/application-properties#assignment-required).

For existing installations, update these settings on the existing scope and enterprise application too. Preserve the `Validation.Access` scope ID and existing app-role definitions/assignments. Verify the app manifest has `api.oauth2PermissionScopes` entry `value: Validation.Access`, `type: Admin`, `isEnabled: true`, and the enterprise application has `appRoleAssignmentRequired: true`. These Entra objects are configured separately from Bicep; a code deployment does not change them. See [Microsoft's assignment guidance](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal) and [enterprise application properties](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-configure).

Do not add a redirect URI yet; the hostname is produced by the first workflow run. The secret is consumed by Easy Auth and stored as a Container App secret, not passed to the Python process.

## 4. Create the GitHub Actions deployment identity and OIDC trust

Create a Microsoft Entra service principal dedicated to deployments. Configure a federated identity credential on its app registration with:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:<OWNER>/<REPOSITORY>:environment:production`
- Audience: `api://AzureADTokenExchange`

Replace `<OWNER>` and `<REPOSITORY>` with the exact GitHub repository path. The subject must match because the workflow declares `environment: production`.

The deployment identity needs permission to create subscription deployments and resource groups, deploy into all four groups, build images in ACR, and create role definitions/assignments in admin and data. On a dedicated subscription, **Contributor** plus **User Access Administrator** at subscription scope is a straightforward bootstrap setup. For narrower access, an administrator can precreate the four groups, grant Contributor on each and User Access Administrator on admin/data, and supply a subscription-scoped custom role permitting deployment operations and resource-group reads/writes. Resource-group-only grants are insufficient for these subscription-scope entry points. Worker custom roles require `Microsoft.Authorization/roleDefinitions/write`; Role Based Access Control Administrator alone is insufficient. Runtime identities retain only the resource-scoped grants declared in Bicep.

Do not enable ACR admin credentials to bypass permissions. Allow time for role propagation before retrying. The foundation creates the groups and grants the runtime and worker identities storage permissions and AcrPull.

Record the deployment service principal's **Application (client) ID**. It will be the `AZURE_DEPLOY_CLIENT_ID` value, distinct from the portal/API app registration ID.

To configure the deployment registration in the portals:

1. In Entra, open **Identity > Applications > App registrations > New registration**. Name it `PDF Validation GitHub Deploy`, choose **Accounts in this organizational directory only**, leave redirect URI empty and register it. Copy its **Application (client) ID**; this is `AZURE_DEPLOY_CLIENT_ID`.
2. Open **Certificates & secrets > Federated credentials > Add credential**, choose the GitHub Actions scenario, and enter the exact organization, repository and `production` environment. Verify the issuer, subject and audience listed above before saving.
3. In Azure, open **Subscriptions > the dedicated deployment subscription > Access control (IAM) > Add role assignment**. For the bootstrap setup, assign **Contributor** and **User Access Administrator** to the deployment service principal at the approved subscription scope. For narrower permissions, have an administrator configure the alternative in section 2. Allow time for the principal and assignments to propagate.
4. Record `AZURE_DEPLOY_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` for the GitHub environment in section 5. Deployment uses OIDC and requires no deployment client secret. Keep this registration separate from the portal/API registration and its Easy Auth secret.

## 5. Configure the GitHub production environment

In the GitHub repository, open **Settings > Environments** and create an environment named exactly `production`. Add these environment variables:

| Variable | Value |
| --- | --- |
| `AZURE_DEPLOY_CLIENT_ID` | Deployment service principal application/client ID |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_ENV` | Environment token; defaults to `prod`; 1–5 lowercase letters/digits, starting with a letter |
| `AZURE_LOCATION` | Required Azure region, e.g. `westus2`; no workflow default |
| `API_CLIENT_ID` | Portal/API app registration application/client ID from step 3 |
| `AZURE_PROJECT` | Project token; defaults to `pdfportal`; 1–10 lowercase letters/digits, starting with a letter |
| `ALERT_EMAIL` | Operations alert recipient; optional |

Add the Easy Auth client secret **Value** from step 3 as an environment secret named `ENTRA_CLIENT_SECRET`. Do not save it as a variable. The workflow writes it to a temporary parameter file for deployment and removes that file on exit. Configure environment protection or required reviewers to match your release policy.

## 6. Run the required provisioning and deployment workflow

1. Push the deployment workflow and Bicep templates to the GitHub repository's default branch. The workflow is `.github/workflows/deploy.yml` and is triggered manually.
2. In GitHub, open **Actions > Deploy Azure > Run workflow**, choose the branch containing the deployment files, and start the run.
3. Watch the job through these steps: deployment settings/name validation, Bicep compile, foundation provisioning, ACR image build, application deployment, CORS update, and readiness check. The build image uses the commit's full Git SHA as its immutable tag.
4. If the run fails during initial resource provisioning or role propagation, inspect the failed deployment under **Subscriptions > your subscription > Deployments**, then follow failed modules into the relevant resource group's **Deployments** view and the GitHub job log. Resolve the specific permission or provider-registration issue, then rerun the workflow. It is designed to be repeatable.
5. On success, open the workflow run summary and copy the printed portal URL. The workflow also prints the exact callback URI to configure.

## 7. Add the callback and complete first sign-in

1. Return to the `PDF Validation Portal` app registration in Entra. Open **Authentication > Add a platform > Web**.
2. Add the callback URL printed in the successful workflow summary:

   ```text
   https://<PORTAL_HOSTNAME>/.auth/login/aad/callback
   ```

   Save it as a **Web** redirect URI. Do not use a SPA platform callback.
3. Confirm assigned users/groups have `Validation.User`, then open the portal and sign in. The portal uses `/.auth/login/aad`; sign-out uses `/.auth/logout`.
4. Run **Deploy Azure** again after callback setup. Each deployment keeps the same hostname and reapplies the foundation CORS rule for the deployed portal origin.

## What the workflow provisions

`Deploy Azure` runs `az bicep build` and then provisions the resources defined by `infra/foundation.bicep` and `infra/main.bicep`: separate runtime and worker managed identities, private Blob container, queue/table storage, Premium ACR with admin access disabled, Log Analytics, an API environment and a separate worker VNet/environment with private endpoints and restricted egress, Easy Auth-protected API, worker and maintenance jobs, and monitoring alerts. It uses managed identity for app-to-storage/registry access and GitHub OIDC for deployment authentication.

The app is externally reachable over HTTPS. Easy Auth returns 401 for unauthenticated protected API routes; the public shell and health/configuration endpoints contain no document data. Never expose the Python container port through another ingress or proxy. Uploaded PDFs and reports expire after 72 hours. Log Analytics retention is 30 days. Storage versioning, soft delete, and backups are not enabled by these templates.

The first deployment includes the separate worker identity and private environment. See [worker isolation](worker-isolation.md) for permissions, network boundaries and post-deployment checks. Include Premium ACR and four private endpoints in the deployment budget.

## Verify the deployment

- Open `https://<PORTAL_HOSTNAME>/health/ready`; it should return success.
- Verify anonymous `/api/session` and `/api/v1/documents` requests return 401.
- Reopen the portal enterprise application's **Properties** and confirm **Assignment required? = Yes**. Sign in with an assigned staff account and verify the session and sign-out flow. In a separate private browser session, confirm an unassigned non-administrator is blocked by Entra and cannot access documents.
- Verify authorized machine integrations use `Validation.Run`; test rejected wrong-tenant, wrong-audience, expired, and missing-role tokens. For delegated integrations, confirm a fresh token with both `Validation.Access` and `Validation.User` succeeds; scope-only, role-only bearer and wrong-scope requests must return 403.
- Upload sample PDFs and check results, report downloads, per-user ownership, and cookie mutation protection.
- Check worker processing, cleanup, Blob upload CORS, managed identity permissions, alerts, and representative workload.

Azure's authentication boundary, token validation, and header sanitization can only be confirmed against a real deployment.

## Subsequent releases and rollback

For every release, run **Actions > Deploy Azure** again. The workflow builds the current commit and deploys that image using its Git SHA; it also reapplies Easy Auth and infrastructure settings. To roll back, rerun the workflow from a commit containing the previous compatible application and infrastructure version. Preserve storage and in-flight job compatibility, and do not disable Easy Auth while the application trusts its validated claims. Do not delete any of the resource groups as a rollback method.
