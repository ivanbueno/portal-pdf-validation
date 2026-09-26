# Fresh Azure deployment through GitHub Actions

This guide provisions and deploys the PDF Validation Portal using the repository's **Deploy Azure** workflow at `.github/workflows/deploy.yml`. Run that workflow for every provisioning and application deployment; do not deploy the Bicep templates or build/push the image by hand. A few one-time prerequisites must be created outside the workflow: the empty resource group, Entra app registration, GitHub OIDC trust, and GitHub environment settings.

The workflow provisions the shared Azure foundation, builds the image in Azure Container Registry, deploys the Container App with Entra Easy Auth, configures worker and maintenance jobs and alerts, sets Blob Storage CORS, and checks readiness. The first run creates the portal hostname. You then add that hostname as the Entra Web callback before staff sign in.

## 1. Choose names and collect identifiers

Choose a dedicated Azure subscription, a new resource group, and a lowercase alphanumeric prefix 3–10 characters long. This guide uses `pdf-validation-prod` and `pdfval`. The workflow defaults the prefix to `pdfval`; set `AZURE_PREFIX` explicitly if using another value. Record:

- Azure subscription ID
- Microsoft Entra tenant ID
- GitHub repository owner and repository name
- Alert email address, if desired

## 2. Create the resource group

An authorized Azure administrator creates the empty resource group once. This is bootstrap only; all application resources inside it are provisioned by `Deploy Azure`.

```sh
az login
SUBSCRIPTION_ID="YOUR_SUBSCRIPTION_ID"
RESOURCE_GROUP=pdf-validation-prod
LOCATION=westus2
az account set --subscription "$SUBSCRIPTION_ID"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
```

The deployment identity in the next step needs resource creation, ACR build, and role assignment permissions scoped to this resource group. Allow the `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.Storage`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`, `Microsoft.Insights`, and `Microsoft.Authorization` providers to register. An administrator may register these providers ahead of time if the deployment identity cannot.

## 3. Register the portal/API in Entra

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open **Identity > Applications > App registrations > New registration**.
2. Name it `PDF Validation Portal`, select **Accounts in this organizational directory only**, and leave redirect URI empty for now. Create it and record its **Directory (tenant) ID** and **Application (client) ID**.
3. Under **Expose an API**, set the Application ID URI to `api://<APPLICATION_CLIENT_ID>`. Set `api.requestedAccessTokenVersion` to `2` in the app manifest.
4. Add an enabled delegated scope named `Validation.Access` for approved integrations that call on behalf of a user.
5. Add these enabled app roles under **App roles**:
   - `Validation.User`, allowed member types **Users/Groups**
   - `Validation.Run`, allowed member types **Applications**
6. Under **Certificates & secrets**, create a client secret for Easy Auth. Copy the secret **Value**; GitHub will store it in step 6. Choose an expiry that supports your rotation policy.
7. In **Enterprise applications**, assign authorized staff/groups the `Validation.User` role. Assign `Validation.Run` only to approved integration service principals. Configure assignment requirements, tenant consent, and Conditional Access/MFA according to organizational policy.

Do not add a redirect URI yet; the hostname is produced by the first workflow run. The secret is consumed by Easy Auth and stored as a Container App secret, not passed to the Python process.

## 4. Create the GitHub Actions deployment identity and OIDC trust

Create a Microsoft Entra service principal dedicated to deployments. Configure a federated identity credential on its app registration with:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:<OWNER>/<REPOSITORY>:environment:production`
- Audience: `api://AzureADTokenExchange`

Replace `<OWNER>` and `<REPOSITORY>` with the exact GitHub repository path. The subject must match because the workflow declares `environment: production`.

Grant the service principal sufficient permissions at the resource group scope to create and update all resources, build images in ACR, and create managed-identity role assignments. The workflow's first deployment assigns the runtime identity access to storage and registry resources. A typical setup grants **Contributor** and **Role Based Access Control Administrator** scoped to this resource group. Use equivalent custom roles if your organization's policy requires them. Do not enable ACR admin credentials to bypass permissions. Role assignment changes can take time to propagate; rerun the workflow if the first attempt encounters a propagation delay.

Record the deployment service principal's **Application (client) ID**. It will be the `AZURE_DEPLOY_CLIENT_ID` value, distinct from the portal/API app registration ID.

## 5. Configure the GitHub production environment

In the GitHub repository, open **Settings > Environments** and create an environment named exactly `production`. Add these environment variables:

| Variable | Value |
| --- | --- |
| `AZURE_DEPLOY_CLIENT_ID` | Deployment service principal application/client ID |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_RESOURCE_GROUP` | Resource group name from step 2 |
| `API_CLIENT_ID` | Portal/API app registration application/client ID from step 3 |
| `AZURE_PREFIX` | Chosen prefix; optional only when using `pdfval` |
| `ALERT_EMAIL` | Operations alert recipient; optional |

Add the Easy Auth client secret **Value** from step 3 as an environment secret named `ENTRA_CLIENT_SECRET`. Do not save it as a variable. The workflow writes it to a temporary parameter file for deployment and removes that file on exit. Configure environment protection or required reviewers to match your release policy.

## 6. Run the required provisioning and deployment workflow

1. Push the deployment workflow and Bicep templates to the GitHub repository's default branch. The workflow is `.github/workflows/deploy.yml` and is triggered manually.
2. In GitHub, open **Actions > Deploy Azure > Run workflow**, choose the branch containing the deployment files, and start the run.
3. Watch the job through these steps: Bicep compile, foundation provisioning, ACR image build, application deployment, CORS update, and readiness check. The build image uses the commit's full Git SHA as its immutable tag.
4. If the run fails during initial resource provisioning or role propagation, inspect the failed deployment in the Azure resource group's **Deployments** view and the GitHub job log. Resolve the specific permission or provider-registration issue, then rerun the workflow. It is designed to be repeatable.
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

`Deploy Azure` runs `az bicep build` and then provisions the resources defined by `infra/foundation.bicep` and `infra/main.bicep`: user-assigned managed identity, private Blob container, queue/table storage, ACR with admin access disabled, Log Analytics, Container Apps environment, Easy Auth-protected API, worker and maintenance jobs, and monitoring alerts. It uses managed identity for app-to-storage/registry access and GitHub OIDC for deployment authentication.

The app is externally reachable over HTTPS. Easy Auth returns 401 for unauthenticated protected API routes; the public shell and health/configuration endpoints contain no document data. Never expose the Python container port through another ingress or proxy. Uploaded PDFs and reports expire after 72 hours. Log Analytics retention is 30 days. Storage versioning, soft delete, and backups are not enabled by these templates.

## Verify the deployment

- Open `https://<PORTAL_HOSTNAME>/health/ready`; it should return success.
- Verify anonymous `/api/session` and `/api/v1/documents` requests return 401.
- Sign in with an assigned staff account and verify the session and sign-out flow. Confirm an unassigned user cannot access documents.
- Verify authorized machine integrations use `Validation.Run`; test rejected wrong-tenant, wrong-audience, expired, and missing-role tokens. Test delegated integrations with `Validation.Access` if used.
- Upload sample PDFs and check results, report downloads, per-user ownership, and cookie mutation protection.
- Check worker processing, cleanup, Blob upload CORS, managed identity permissions, alerts, and representative workload.

Azure's authentication boundary, token validation, and header sanitization can only be confirmed against a real deployment.

## Subsequent releases and rollback

For every release, run **Actions > Deploy Azure** again. The workflow builds the current commit and deploys that image using its Git SHA; it also reapplies Easy Auth and infrastructure settings. To roll back, rerun the workflow from a commit containing the previous compatible application and infrastructure version. Preserve storage and in-flight job compatibility, and do not disable Easy Auth while the application trusts its validated claims. Do not delete the resource group as a rollback method.
