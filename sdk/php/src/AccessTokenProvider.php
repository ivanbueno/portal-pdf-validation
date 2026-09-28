<?php
declare(strict_types=1);

namespace PdfValidation;

interface AccessTokenProvider
{
    public function getAccessToken(): string;
}
