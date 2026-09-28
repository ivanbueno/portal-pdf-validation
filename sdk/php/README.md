# PDF Validation Portal PHP SDK

Composer package for the versioned PDF Validation Portal API. Requires PHP 8.1+ and PSR-18, PSR-17, and PSR-7 implementations. Drupal applications can pass their configured HTTP client and PSR factories; standalone applications commonly use Guzzle with `guzzlehttp/guzzle` and `http-interop/http-factory-guzzle`.

## Install

Install the package in a consuming project with a path repository or publish it to your Composer registry. The package requirements are declared in `sdk/php/composer.json`.

```json
{
  "repositories": [{ "type": "path", "url": "../portal-pdf-validation/sdk/php" }],
  "require": { "pdf-validation-portal/sdk": "*" }
}
```

## Configure authentication

The API expects an Entra access token for the portal API. You can supply a token managed by your application:

```php
use PdfValidation\Client;
use PdfValidation\StaticAccessTokenProvider;

$client = new Client($portalUrl, $httpClient, $requestFactory, $streamFactory,
    new StaticAccessTokenProvider($accessToken));
```

Or let the SDK request and cache a token using the client-credentials flow. Set the scope to `api://<PORTAL_API_CLIENT_ID>/.default`. Load the secret from your secret manager or Drupal configuration; do not commit it or log it.

```php
use PdfValidation\Client;
use PdfValidation\EntraClientCredentialsTokenProvider;

$tokens = new EntraClientCredentialsTokenProvider(
    $httpClient, $requestFactory, $streamFactory,
    $tenantId, $clientId, $clientSecret,
    'api://' . $portalApiClientId . '/.default',
);
$client = new Client($portalUrl, $httpClient, $requestFactory, $streamFactory, $tokens);
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

For streamed uploads, pass a PSR-7 `StreamInterface` to `uploadAndSubmit()` or `uploadFile()`. Lower-level methods are available as well: `createDocument()`, `uploadFile()`, `renewUploadUrl()`, and `submit()`.

## Drupal integration

Inject Drupal's PSR-18 HTTP client and PSR-17 request/stream factories into `Client` and the token provider from a service definition. If your Drupal version exposes a Guzzle client but not PSR factories, add a PSR-17 Guzzle factory package and adapt/inject the client through its PSR-18 interface. Keep tenant, client ID, API client ID, and portal URL in configuration; keep the client secret in the site's secret-management mechanism.

## Security and errors

Upload URLs are temporary credentials. The SDK does not log them and never forwards the Entra bearer token to Blob Storage. Do not log upload URLs, client secrets, or bearer tokens in the calling application either.

Non-2xx responses throw `ApiException`, exposing `getStatusCode()`, `getRequestId()`, and `getApiDetail()`. Network failures throw `TransportException`. The SDK does not decide polling intervals or interpret a completed `failed` validation as an HTTP error.
