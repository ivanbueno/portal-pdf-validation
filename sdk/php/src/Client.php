<?php
declare(strict_types=1);

namespace PdfValidation;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use Psr\Http\Message\StreamInterface;

/** Client for the PDF Validation Portal's version 1 API. */
final class Client
{
    private readonly string $apiBaseUrl;

    public function __construct(
        string $baseUrl,
        private readonly ClientInterface $httpClient,
        private readonly AccessTokenProvider $tokens,
    ) {
        $baseUrl = rtrim($baseUrl, '/');
        if (!preg_match('~^https?://~i', $baseUrl)) {
            throw new \InvalidArgumentException('Base URL must be an absolute HTTP(S) URL.');
        }
        $this->apiBaseUrl = str_ends_with($baseUrl, '/api/v1') ? $baseUrl : $baseUrl . '/api/v1';
    }

    public function createDocument(string $name, ?int $size = null, ?array $profiles = null, ?string $idempotencyKey = null): array
    {
        $payload = ['name' => $name];
        if ($size !== null) $payload['size'] = $size;
        if ($profiles !== null) $payload['profiles'] = $profiles;
        $headers = [];
        if ($idempotencyKey !== null) $headers['Idempotency-Key'] = $idempotencyKey;
        return $this->apiJson('POST', '/documents', $payload, $headers);
    }

    /** Upload a local path or PSR-7 stream to the temporary Azure Blob URL. */
    public function uploadFile(string|StreamInterface $file, string $uploadUrl, ?int $size = null, string $contentType = 'application/pdf'): void
    {
        $closeBody = is_string($file);
        if ($closeBody) {
            if (!is_file($file) || !is_readable($file)) {
                throw new \InvalidArgumentException('File path must refer to a readable file.');
            }
            $body = fopen($file, 'rb');
            if ($body === false) throw new \RuntimeException('Unable to open PDF file.');
            $size ??= filesize($file) ?: null;
        } else {
            $body = $file;
            if ($size === null && $body->getSize() !== null) $size = $body->getSize();
        }

        $headers = ['x-ms-blob-type' => 'BlockBlob', 'Content-Type' => $contentType];
        if ($size !== null) $headers['Content-Length'] = (string) $size;
        try {
            $this->send('PUT', $uploadUrl, ['headers' => $headers, 'body' => $body], false);
        } finally {
            if ($closeBody && is_resource($body)) fclose($body);
        }
    }

    public function renewUploadUrl(string $documentId): array
    {
        return $this->apiJson('POST', $this->documentPath($documentId) . '/upload-url');
    }

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

    public function getStatus(string $documentId): array
    {
        return $this->apiJson('GET', $this->documentPath($documentId) . '/status');
    }

    public function getJsonReport(string $documentId): array
    {
        return $this->apiJson('GET', $this->documentPath($documentId) . '/reports/json');
    }

    public function getXmlReport(string $documentId, string $profile): string
    {
        return $this->apiRaw('GET', $this->documentPath($documentId) . '/reports/xml?' . http_build_query(['profile' => $profile]));
    }

    private function apiJson(string $method, string $path, ?array $payload = null, array $headers = []): array
    {
        $options = ['headers' => $headers];
        if ($payload !== null) $options['json'] = $payload;
        $response = $this->send($method, $this->apiBaseUrl . $path, $options, true);
        $data = json_decode((string) $response->getBody(), true);
        if (!is_array($data)) throw new ApiException('API returned invalid JSON.', $response->getStatusCode(), $response->getHeaderLine('X-Request-ID'));
        return $data;
    }

    private function apiRaw(string $method, string $path): string
    {
        return (string) $this->send($method, $this->apiBaseUrl . $path, [], true)->getBody();
    }

    private function send(string $method, string $url, array $options, bool $authenticated): \Psr\Http\Message\ResponseInterface
    {
        if ($authenticated) $options['headers']['Authorization'] = 'Bearer ' . $this->tokens->getAccessToken();
        $options['http_errors'] = false;
        try {
            $response = $this->httpClient->request($method, $url, $options);
        } catch (GuzzleException $error) {
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
