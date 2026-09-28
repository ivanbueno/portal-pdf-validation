<?php
declare(strict_types=1);

namespace PdfValidation;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;

final class EntraClientCredentialsTokenProvider implements AccessTokenProvider
{
    private ?string $token = null;
    private int $expiresAt = 0;

    public function __construct(
        private readonly ClientInterface $httpClient,
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
        try {
            $response = $this->httpClient->request('POST', $url, [
                'form_params' => [
                    'client_id' => $this->clientId,
                    'client_secret' => $this->clientSecret,
                    'grant_type' => 'client_credentials',
                    'scope' => $this->scope,
                ],
                'http_errors' => false,
            ]);
        } catch (GuzzleException $error) {
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
