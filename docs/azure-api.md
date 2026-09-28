# Configure Entra Easy Auth for an external API client

This guide configures a machine-to-machine client to call a deployed PDF Validation Portal API. It assumes the portal has already been deployed through the **Deploy Azure** workflow described in [azure-ci.md](azure-ci.md), and that the portal/API app registration and Easy Auth configuration exist.

The client uses the OAuth 2.0 client credentials flow. Its client secret (sometimes called an access key) is exchanged with Microsoft Entra for a short-lived access token. The client sends that token to the portal as a bearer token. Do not send the client secret to the portal API; do not use it as an API key. Easy Auth validates the token and the application requires the `Validation.Run` role.

## 1. Confirm the portal API registration

In the Microsoft Entra admin center, open **Identity → Applications → App registrations → PDF Validation Portal**. Record:

- **Directory (tenant) ID**
- **Application (client) ID**
- Application ID URI, expected to be `api://<PORTAL_API_CLIENT_ID>`

Under **Expose an API**, make sure the Application ID URI is set and that the app manifest has `api.requestedAccessTokenVersion` set to `2`.

Under **App roles**, confirm this role is present, enabled, and configured for **Applications**:

| Display name | Value | Allowed member types |
| --- | --- | --- |
| Validation Run | `Validation.Run` | Applications |

The API's Easy Auth configuration is provisioned by `Deploy Azure` with this app registration's tenant and client ID. Avoid changing those identifiers after deployment.

## 2. Register the external client application

The integration should have a dedicated app registration and credentials. Do not reuse the portal registration or the GitHub deployment identity.

For an integration operated in your Entra tenant:

1. Open **App registrations → New registration**.
2. Name it for the integration, for example `PDF Validation Partner Integration`.
3. Choose **Accounts in this organizational directory only** and leave redirect URI empty. This client runs as an application and has no interactive sign-in redirect.
4. Select **Register**. Record the new app's **Application (client) ID**. This is the client ID the integration will use.

The API registration in this deployment is single-tenant. If a partner manages the client app in another tenant, coordinate with your Entra administrator: the partner's app must be consented and represented by a service principal in the API's tenant, and the issued token must be for the API tenant. Do not assume a client ID and secret from an unrelated tenant can call this API without that setup.

## 3. Add the API application permission

While viewing the **integration's** app registration:

1. Go to **API permissions → Add a permission → My APIs**.
2. Select **PDF Validation Portal**.
3. Select **Application permissions** (not Delegated permissions).
4. Select **Validation.Run**, then choose **Add permissions**.
5. Select **Grant admin consent for <tenant>** and confirm. An appropriately privileged Entra administrator must approve this application permission.
6. Confirm the API permissions page shows `Validation.Run` with status **Granted for <tenant>**.

If `PDF Validation Portal` does not appear under **My APIs**, check that both app registrations are in the tenant you are viewing and that the portal registration defines an enabled `Validation.Run` role whose allowed member type is **Applications**. Microsoft also requires both the API app and client app to have an owner for them to appear in the permission picker; add your admin account under **Owners** on each registration if needed. See Microsoft's [app roles setup guide](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps).

## 4. Create and store a client credential

1. In the integration app registration, open **Certificates & secrets → Client secrets → New client secret**.
2. Add a description and choose an expiry that matches your credential rotation policy.
3. Select **Add**, then copy the secret **Value** immediately. The value is shown only once.
4. Store the value in the integration's secret manager (for example, Azure Key Vault or the partner's approved vault). Do not put it in source control, tickets, logs, or command history. Prefer a certificate or workload federation over a client secret where the integration and tenant support it.

Record these client configuration values in the integration's secret manager/configuration:

- Tenant ID: the **API resource tenant** ID
- Client ID: the integration app's **Application (client) ID**
- Client secret: the secret **Value** created above
- Token scope: `api://<PORTAL_API_CLIENT_ID>/.default`
- API base URL: the portal origin printed by the successful **Deploy Azure** workflow

## 5. Request an access token

Use the tenant-specific v2 token endpoint. The client secret is sent only to Microsoft Entra's token endpoint over HTTPS. The response contains an `access_token`; use it as a bearer token for API requests.

```sh
TENANT_ID="YOUR_API_TENANT_ID"
CLIENT_ID="YOUR_INTEGRATION_CLIENT_ID"
CLIENT_SECRET="LOAD_FROM_YOUR_SECRET_MANAGER"
API_CLIENT_ID="YOUR_PORTAL_API_CLIENT_ID"

TOKEN=$(curl --fail-with-body --silent --show-error \
  --request POST "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "client_secret=${CLIENT_SECRET}" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "scope=api://${API_CLIENT_ID}/.default" \
  | jq -r '.access_token')
```

In production, load the secret directly from a vault or secret manager rather than assigning it in an interactive shell. Do not print or log `$TOKEN`. Cache tokens until shortly before their `expires_in` time; request a new token when needed. Client credentials do not issue refresh tokens.

## 6. Call the API with the bearer token

Send the access token in the `Authorization` header. Do not send `X-MS-CLIENT-PRINCIPAL`; Easy Auth supplies the validated principal. Bearer-token API clients do not need the browser-only `X-Requested-With` header.

Example: create a document reservation, upload the PDF directly to its temporary Blob URL, and submit it. Set `PDF_PATH` to the local file. See [api.md](api.md) for the full upload → submit → poll → download process and endpoint details.

```sh
BASE="https://YOUR_PORTAL_HOSTNAME"
PDF_PATH="sample.pdf"
RESERVATION=$(curl --fail-with-body --silent --show-error "$BASE/api/v1/documents" \
  --header "Authorization: Bearer $TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"name":"sample.pdf","profiles":["wcag","pdfua1"]}')
UPLOAD_URL=$(printf '%s' "$RESERVATION" | jq -r '.upload_url')
DOCUMENT_ID=$(printf '%s' "$RESERVATION" | jq -r '.id')

# Upload URL is a temporary credential. Do not include the Entra bearer token here.
curl --fail-with-body --request PUT "$UPLOAD_URL" \
  --header 'x-ms-blob-type: BlockBlob' \
  --header 'Content-Type: application/pdf' \
  --data-binary "@$PDF_PATH"

# Submit the uploaded PDF through the API with the Entra bearer token.
curl --fail-with-body --request POST "$BASE/api/v1/documents/$DOCUMENT_ID/submit" \
  --header "Authorization: Bearer $TOKEN"

# Check progress; repeat this request until status is passed, failed, or error.
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID/status" \
  --header "Authorization: Bearer $TOKEN" | jq '{id, status, profiles}'

# After processing completes, download the complete normalized JSON report.
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID/reports/json" \
  --header "Authorization: Bearer $TOKEN" \
  --output "${DOCUMENT_ID}-report.json"

# Optional: download the original XML report for one validation profile.
curl --fail-with-body "$BASE/api/v1/documents/$DOCUMENT_ID/reports/xml?profile=pdfua-1" \
  --header "Authorization: Bearer $TOKEN" \
  --output "${DOCUMENT_ID}-pdfua.xml"
```

The status endpoint returns the current state (`uploading`, `queued`, `running`, `passed`, `failed`, or `error`) and profile summaries. Poll with a delay/backoff while the state is `queued` or `running`; request reports after it reaches a terminal state (`passed`, `failed`, or `error`). Treat the upload URL as a temporary credential and do not log or share it. Documents and reports are scoped to the calling application's service principal; separate client applications have separate document ownership.

## 7. Check access and troubleshoot

- `200`, `201`, or another route-specific success: the token was accepted and the requested action succeeded.
- `401`: check the token endpoint tenant, token audience (`api://<PORTAL_API_CLIENT_ID>`), token expiry, API base URL, and that the request contains `Authorization: Bearer <token>`.
- `403` with a missing `Validation.Run` role: confirm the integration requested **Application permissions → Validation.Run**, admin consent is granted, and you requested a new token after consent. Decode the access token locally for troubleshooting and verify its `roles` claim contains `Validation.Run`; never paste production tokens into public sites or tickets.
- `404`: the document may not exist or may belong to another user/application. Document ownership is isolated by tenant and service principal.
- Token error `invalid_client`: confirm the client ID and secret **Value**, that the secret is not expired, and that the token request is sent to the API tenant's token endpoint.

Easy Auth performs signature, issuer, audience, expiry, and tenant validation at the Azure boundary. FastAPI then checks the injected application role and scopes documents to the service principal. Local tests cannot prove the deployed Entra and Easy Auth configuration.
