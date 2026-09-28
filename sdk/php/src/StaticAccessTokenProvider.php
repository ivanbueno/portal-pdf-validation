<?php
declare(strict_types=1);

namespace PdfValidation;

final class StaticAccessTokenProvider implements AccessTokenProvider
{
    public function __construct(private readonly string $token)
    {
        if ($token === '') {
            throw new \InvalidArgumentException('Access token must not be empty.');
        }
    }

    public function getAccessToken(): string
    {
        return $this->token;
    }
}
