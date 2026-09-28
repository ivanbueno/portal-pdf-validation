<?php
declare(strict_types=1);

namespace PdfValidation;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Psr\Http\Message\StreamInterface;

/** Client for the PDF Validation Portal's version 1 API. */
final class Client
{
    private readonly string $apiBaseUrl;

    public function __construct(
        string $baseUrl,
        private readonly ClientInterface $httpClient,
        private readonly RequestFactoryInterface $requestFactory,
        private readonly StreamFactoryInterface $streamFactory,
        private readonly AccessTokenProvider $tokens,
    ) {
        $baseUrl = rtrim($baseUrl, '/');
        if (!preg_match('~^https?://~i', $baseUrl)) {
            throw new \InvalidArgumentException('Base URL must be an absolute HTTP(S) URL.');
        }
        $this->apiBaseUrl = str_ends_with($baseUrl, '/api/v1') ? $baseUrl : $baseUrl . '/api/v1';
    }

    /** Reserve a document. The response contains id and a temporary upload_url. */
    public function createDocument(string $name, ?int $size = null, ?array $profiles = null, ?string $idempotencyKey = null): array
    {
        $payload = ['name' => $name];
        if ($size !== null) $payload['size'] = $size;
        if ($profiles !== null) $payload['profiles'] = $profiles;
        $headers = ['Content-Type' => 'application/json'];
        if ($idempotencyKey !== null) $headers['Idempotency-Key'] = $idempotencyKey;
        return $this->apiJson('POST', '/documents', $payload, $headers);
    }

    /** Upload a local file path or PSR-7 stream to the temporary Azure Blob URL. */
    public function uploadFile(string|StreamInterface $file, string $uploadUrl, ?int $size = null, string $contentType = 'application/pdf'): void
    {
        if (is_string($file)) {
            if (!is_file($file) || !is_readable($file)) {
                throw new \InvalidArgumentException('File path must refer to a readable file.');
            }
            $body = $this->streamFactory->createStreamFromFile($file, 'r');
            $size ??= filesize($file) ?: null;
        } else {
            $body = $file;
            if ($size === null && $body->getSize() !== null) $size = $body->getSize();
        }
        $request = $this->requestFactory->createRequest('PUT', $uploadUrl)
            ->withHeader('x-ms-blob-type', 'BlockBlob')
            ->withHeader('Content-Type', $contentType);
        if ($size !== null) $request = $request->withHeader('Content-Length', (string) $size);
        $this->send($request->withBody($body), false);
    }

    /** Renew the upload grant for an active, unsubmitted document. */
    public function renewUploadUrl(string $documentId): array
    {
        return $this->apiJson('POST', $this->documentPath($documentId) . '/upload-url');
    }

    /** Submit an uploaded document for validation. */
    public function submit(string $documentId): array
    {
        return $this->apiJson('POST', $this->documentPath($documentId) . '/submit');
    }

    /** Reserve, upload, and submit one PDF. Returns the reservation response. */
    public function uploadAndSubmit(
        string|StreamInterface $file,
        string $name,
        ?int $size = null,
        ?array $profiles = null,
        ?string $idempotencyKey = null,
    ): array {
        if ($size === null && is_string($file) && is_file($file)) $size = filesize($file) ?: null;
        $reservation = $this->createDocument($name, $size, $profiles, $idempotencyKey);
        if (!isset($reservation['id'], $reservation['upload_url'])) {
            throw new ApiException('Reservation response is missing id or upload_url.', 0, null, $reservation);
        }
        $this->uploadFile($file, (string) $reservation['upload_url'], $size);
        $this->submit((string) $reservation['id']);
        return $reservation;
    }

    /** Get the current state and profile summaries without downloading reports. */
    public function getStatus(string $documentId): array
    {
        return $this->apiJson('GET', $this->documentPath($documentId) . '/status');
    }

    /** Get the complete normalized JSON report as a decoded PHP value. */
    public function getJsonReport(string $documentId): array
    {
        return $this->apiJson('GET', $this->documentPath($documentId) . '/reports/json');
    }

    /** Get original XML report contents for profile `pdfua-1` or `wcag-2.2`. */
    public function getXmlReport(string $documentId, string $profile): string
    {
        return $this->apiRaw('GET', $this->documentPath($documentId) . '/reports/xml?' . http_build_query(['profile' => $profile]));
    }

    private function apiJson(string $method, string $path, ?array $payload = null, array $headers = []): array
    {
        $request = $this->requestFactory->createRequest($method, $this->apiBaseUrl . $path);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        if ($payload !== null) $request = $request->withBody($this->streamFactory->createStream(json_encode($payload, JSON_THROW_ON_ERROR)));
        $response = $this->send($request, true);
        $data = json_decode((string) $response->getBody(), true);
        if (!is_array($data)) throw new ApiException('API returned invalid JSON.', $response->getStatusCode(), $response->getHeaderLine('X-Request-ID'));
        return $data;
    }

    private function apiRaw(string $method, string $path): string
    {
        return (string) $this->send($this->requestFactory->createRequest($method, $this->apiBaseUrl . $path), true)->getBody();
    }

    private function send(\Psr\Http\Message\RequestInterface $request, bool $authenticated): \Psr\Http\Message\ResponseInterface
    {
        if ($authenticated) $request = $request->withHeader('Authorization', 'Bearer ' . $this->tokens->getAccessToken());
        try {
            $response = $this->httpClient->sendRequest($request);
        } catch (\Throwable $error) {
            throw new TransportException('HTTP request failed.', 0, $error);
        }
        $status = $response->getStatusCode();
        if ($status < 200 || $status >= 300) {
            $contents = (string) $response->getBody();
            $data = json_decode($contents, true);
            $detail = is_array($data) ? ($data['detail'] ?? null) : null;
            $message = is_string($detail) ? $detail : 'API request failed with HTTP ' . $status . '.';
            throw new ApiException($message, $status, $response->getHeaderLine('X-Request-ID') ?: null, $detail);
        }
        return $response;
    }

    private function documentPath(string $id): string
    {
        if ($id === '') throw new \InvalidArgumentException('Document ID must not be empty.');
        return '/documents/' . rawurlencode($id);
    }
}
