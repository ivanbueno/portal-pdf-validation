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

```sh
for provider in \
  Microsoft.App \
  Microsoft.Authorization \
  Microsoft.ContainerRegistry \
  Microsoft.Insights \
  Microsoft.ManagedIdentity \
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
4. Add an enabled delegated scope named `Validation.Access` for approved integrations that call on behalf of a user.

> In the portal/API app registration (the one named PDF Validation > Portal):
>
> a. Open Expose an API. If you haven’t set an Application ID URI yet, > select Add and save the suggested api://<application-client-id> URI.
> b. Select Add a scope.
> b. Set Scope name to Validation.Access.
> d. Choose Who can consent:
>    - Admins only if an administrator should approve every client.
>    - Admins and users if users can approve it themselves and your > tenant allows user consent.
> e. Fill in the admin consent and, if applicable, user consent display > names and descriptions. For example: “Access PDF Validation Portal on > behalf of the signed-in user.”
> f. Leave State set to Enabled, then select Add scope.
>
> The resulting scope identifier is:
> api://<APPLICATION_CLIENT_ID>/Validation.Access
>
> An integration’s app registration must then request this delegated > permission under API permissions → Add a permission → My APIs → PDF > Validation Portal → Delegated permissions. Grant consent as required > by the choice above. Microsoft’s guide to exposing an API scope has > the corresponding portal steps.

5. Add these enabled app roles under **App roles**:
   - `Validation.User`, allowed member types **Users/Groups**
   - `Validation.Run`, allowed member types **Applications**

For each role, create an enabled app role in the PDF Validation Portal app registration. In App roles → Create app role, set:

|Field	| Validation.User	| Validation.Run|
| -------- | -------- | -------- |
|Display name | Validation User | Validation Run|
|Allowed member types | Users/Groups | Applications|
|Value | Validation.User | Validation.Run|
|Description | Allows assigned staff to use the PDF Validation Portal. | Allows an approved integration application to run  PDF validations.|
|Do you want to enable this app role? | Yes | Yes|

The Value is the exact role string the application checks in the validated claims. Assign Validation.User to staff or groups, and Validation. Run only to approved integration service principals.

6. Under **Certificates & secrets**, create a client secret for Easy Auth. Copy the secret **Value**; GitHub will store it in step 6. Choose an expiry that supports your rotation policy.
7. In **Enterprise applications**, assign authorized staff/groups the `Validation.User` role. Assign `Validation.Run` only to approved integration service principals. Configure assignment requirements, tenant consent, and Conditional Access/MFA according to organizational policy.

> In the Microsoft Entra admin center, you assign roles > to the app’s enterprise application (its service > principal), not on the App registrations page.
>
> Assign Validation.User to staff or groups
>
> 1. Go to Identity → Applications → Enterprise > applications → All applications.
> 2. Find and open PDF Validation Portal.
> 3. Select Users and groups → Add user/group.
> 4. Under Users and groups, select the staff members or > group you’re authorizing.
> 5. Under Select a role, choose Validation User.
> 6. Select Assign.
>
> If your organization uses groups, assign the role to > the authorized group rather than adding staff one at a > time. Group-based assignment may require an Entra ID > licensing tier; check your organization’s licensing if > the group cannot be assigned.
>
> Assign Validation.Run to an integration
>
> For each approved integration, first make sure it has > its own app registration and enterprise application > (service principal).
> 1. Open the PDF Validation Portal enterprise > application and select Users and groups → Add user/> group.
> 2. Find the integration’s service principal. In the > picker, switch from Users to All users and groups or > Service principals, depending on the portal view.
> 3. Under Select a role, choose Validation Run, then > select Assign.
>
> If the service principal doesn’t appear in the picker, > it may not yet exist in your tenant. Have an > administrator create the integration’s enterprise > application/service principal, then try again. > Validation.Run should be limited to approved > integrations.
>
> Tenant-wide settings
> - Require assignment: In the portal’s enterprise > application, open Properties and set Assignment > required? to Yes if you want Entra to block unassigned > users at sign-in. The app also requires Validation.User > for portal access.
> - Consent: Admin consent for API permissions is managed > under App registrations → PDF Validation Portal → API > permissions → Grant admin consent. For > client-credentials integrations, an administrator also > needs to grant the API application permission/app role > to the integration. Review the requested permissions > before granting consent.
> - Conditional Access and MFA: An Entra administrator > configures these under Protection → Conditional Access. > Apply your organization’s policy to the portal > enterprise application and intended users; test sign-in > after policy changes.

Do not add a redirect URI yet; the hostname is produced by the first workflow run. The secret is consumed by Easy Auth and stored as a Container App secret, not passed to the Python process.

## 4. Create the GitHub Actions deployment identity and OIDC trust

Create a Microsoft Entra service principal dedicated to deployments. Configure a federated identity credential on its app registration with:

- Issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:<OWNER>/<REPOSITORY>:environment:production`
- Audience: `api://AzureADTokenExchange`

Replace `<OWNER>` and `<REPOSITORY>` with the exact GitHub repository path. The subject must match because the workflow declares `environment: production`.

Grant the service principal sufficient permissions at the resource group scope to create and update all resources, build images in ACR, and create managed-identity role assignments. The workflow's first deployment assigns the runtime identity access to storage and registry resources. A typical setup grants **Contributor** and **Role Based Access Control Administrator** scoped to this resource group. Use equivalent custom roles if your organization's policy requires them. Do not enable ACR admin credentials to bypass permissions. Role assignment changes can take time to propagate; rerun the workflow if the first attempt encounters a propagation delay.

Record the deployment service principal's **Application (client) ID**. It will be the `AZURE_DEPLOY_CLIENT_ID` value, distinct from the portal/API app registration ID.

> You’ll create a separate Entra app for GitHub deployments, then give > its service principal Azure permissions on the resource group. These > steps require an Entra app administrator and an Azure administrator > with permission to assign roles.
> 1. Create the deployment app
> In the Microsoft Entra admin center:
>> 1. Go to Identity → Applications → App registrations → New > >registration.
>> 2. Name it PDF Validation GitHub Deploy.
>> 3. Choose Accounts in this organizational directory only, leave > >redirect URI blank, and select Register.
>> 4. On Overview, copy the Application (client) ID. This becomes > >AZURE_DEPLOY_CLIENT_ID.
>> Creating the app registration creates its service principal in your >> tenant.
> 2. Add GitHub’s federated credential
>> 1. In the new app, open Certificates & secrets → Federated >credentials > → Add credential. Depending on the portal view, this may >be under > Federated credentials directly in the app’s menu.
>> 2. Choose GitHub Actions deploying Azure resources as the scenario.
>> 3. Enter your exact GitHub organization or user, repository, and the >> production environment.
>> 4. Confirm the credential shows:
>>    - Issuer: https://token.actions.githubusercontent.com
>>    - Subject: repo:<OWNER>/<REPOSITORY>:environment:production
>>    - Audience: api://AzureADTokenExchange
>> 5. Save it.
> The subject must match the production environment declared in the > workflow. Microsoft’s OIDC setup guide describes configuring the app, > federated credential, and Azure role assignment.
> 3. Assign Azure permissions at the resource group
> In the Azure portal:
>> 1. Open Resource groups → your deployment resource group → Access > control (IAM) → Add → Add role assignment.
>> 2. Assign Contributor to the deployment app’s service principal.  Search for PDF Validation GitHub Deploy under Select members.
>> 3. Repeat Add role assignment for Role Based Access Control Administrator, selecting the same service principal.
>> 4. Confirm both assignments are scoped to this resource group.
>> The workflow creates managed identity role assignments for the app’s storage and registry access, so the deployment identity needs role assignment permissions. If the service principal doesn’t appear immediately in the picker, wait briefly and search again.
> 4. Put the ID in GitHub
> Add the copied client ID as the AZURE_DEPLOY_CLIENT_ID environment > variable in the GitHub production environment. The workflow also needs > AZURE_TENANT_ID and AZURE_SUBSCRIPTION_ID there. It authenticates with > OIDC; do not create a deployment client secret.
> Keep this deployment app separate from the PDF Validation Portal app > registration. The portal registration’s client secret is a different > credential used by Easy Auth.

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
