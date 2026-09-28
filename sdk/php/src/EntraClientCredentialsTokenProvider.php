<?php
declare(strict_types=1);

namespace PdfValidation;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

final class EntraClientCredentialsTokenProvider implements AccessTokenProvider
{
    private ?string $token = null;
    private int $expiresAt = 0;

    public function __construct(
        private readonly ClientInterface $httpClient,
        private readonly RequestFactoryInterface $requestFactory,
        private readonly StreamFactoryInterface $streamFactory,
        private readonly string $tenantId,
        private readonly string $clientId,
        private readonly string $clientSecret,
        private readonly string $scope,
        private readonly int $expirySkewSeconds = 60,
    ) {
        foreach (['tenant ID' => $tenantId, 'client ID' => $clientId, 'client secret' => $clientSecret, 'scope' => $scope] as $label => $value) {
            if ($value === '') {
                throw new \InvalidArgumentException("The {$label} must not be empty.");
            }
        }
    }

    public function getAccessToken(): string
    {
        if ($this->token !== null && time() < $this->expiresAt) {
            return $this->token;
        }

        $url = 'https://login.microsoftonline.com/' . rawurlencode($this->tenantId) . '/oauth2/v2.0/token';
        $body = http_build_query([
            'client_id' => $this->clientId,
            'client_secret' => $this->clientSecret,
            'grant_type' => 'client_credentials',
            'scope' => $this->scope,
        ], '', '&', PHP_QUERY_RFC3986);
        $request = $this->requestFactory->createRequest('POST', $url)
            ->withHeader('Content-Type', 'application/x-www-form-urlencoded')
            ->withBody($this->streamFactory->createStream($body));

        try {
            $response = $this->httpClient->sendRequest($request);
        } catch (\Throwable $error) {
            throw new TransportException('Unable to request an Entra access token.', 0, $error);
        }

        $contents = (string) $response->getBody();
        $data = json_decode($contents, true);
        if ($response->getStatusCode() < 200 || $response->getStatusCode() >= 300) {
            $detail = is_array($data) ? ($data['error_description'] ?? $data['error'] ?? null) : null;
            throw new ApiException('Entra token request failed' . ($detail ? ': ' . $detail : '.'), $response->getStatusCode());
        }
        if (!is_array($data) || !isset($data['access_token']) || !is_string($data['access_token']) || $data['access_token'] === '') {
            throw new ApiException('Entra token response did not contain an access_token.', $response->getStatusCode());
        }

        $lifetime = max(1, (int) ($data['expires_in'] ?? 3600) - max(0, $this->expirySkewSeconds));
        $this->token = $data['access_token'];
        $this->expiresAt = time() + $lifetime;
        return $this->token;
    }
}
