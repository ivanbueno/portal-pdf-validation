# PDF Validation Portal PHP SDK

Composer package for the versioned PDF Validation Portal API. Requires PHP 8.1+ and Guzzle 7. Drupal already uses Guzzle, so its configured client can be injected directly.

## Configure authentication

The API expects an Entra access token for the portal API. You can supply a token managed by your application:

```php
use PdfValidation\Client;
use PdfValidation\StaticAccessTokenProvider;
use GuzzleHttp\Client as GuzzleClient;

$http = new GuzzleClient();
$client = new Client($portalUrl, $http, new StaticAccessTokenProvider($accessToken));
```

Or let the SDK request and cache a token using the client-credentials flow. Set the scope to `api://<PORTAL_API_CLIENT_ID>/.default`. Load the secret from your secret manager or Drupal configuration; do not commit it or log it.

```php
use PdfValidation\Client;
use PdfValidation\EntraClientCredentialsTokenProvider;
use GuzzleHttp\Client as GuzzleClient;

$http = new GuzzleClient();
$tokens = new EntraClientCredentialsTokenProvider(
    $http,
    $tenantId, $clientId, $clientSecret,
    'api://' . $portalApiClientId . '/.default',
);
$client = new Client($portalUrl, $http, $tokens);
```

`$portalUrl` is the portal origin, such as `https://portal.example`; `/api/v1` is added automatically. The client also accepts a URL already ending in `/api/v1`.

## Upload, submit, poll, and download

The convenience method reserves, uploads, and submits one PDF, returning the reservation including its document ID. Pass `wcag`, `pdfua1`, or both profiles. `idempotencyKey` is optional: if omitted, the API generates a key and returns it with the reservation. Provide and persist your own key before the first request if you need to safely retry when the reservation response may be lost; reuse that key with the same document metadata.

```php
$reservation = $client->uploadAndSubmit(
    '/private/files/example.pdf',
    'example.pdf',
    profiles: ['wcag', 'pdfua1'],
    idempotencyKey: $persistedKey, // Optional; omit this argument to let the API generate a key.
);
$documentId = $reservation['id'];

// Poll at an application-appropriate interval until status is passed, failed, or error.
$status = $client->getStatus($documentId);
if (in_array($status['status'], ['passed', 'failed', 'error'], true)) {
    $report = $client->getJsonReport($documentId);
    file_put_contents('/private/reports/' . $documentId . '.json', json_encode($report, JSON_PRETTY_PRINT));
    // Optional original XML report:
    $xml = $client->getXmlReport($documentId, 'pdfua-1');
}
```

For streamed uploads, pass a Guzzle/PSR-7 stream to `uploadAndSubmit()` or `uploadFile()`. Lower-level methods are available as well: `createDocument()`, `uploadFile()`, `renewUploadUrl()`, and `submit()`.

## Drupal integration

Inject Drupal's configured Guzzle client from a service definition into `Client` and the token provider. Keep tenant, client ID, API client ID, and portal URL in configuration; keep the client secret in the site's secret-management mechanism.

## Security and errors

Upload URLs are temporary credentials. The SDK does not log them and never forwards the Entra bearer token to Blob Storage. Do not log upload URLs, client secrets, or bearer tokens in the calling application either.

Non-2xx responses throw `ApiException`, exposing `getStatusCode()`, `getRequestId()`, and `getApiDetail()`. Network failures throw `TransportException`. The SDK does not decide polling intervals or interpret a completed `failed` validation as an HTTP error.
