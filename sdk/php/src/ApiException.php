<?php
declare(strict_types=1);

namespace PdfValidation;

final class ApiException extends \RuntimeException
{
    public function __construct(
        string $message,
        private readonly int $statusCode,
        private readonly ?string $requestId = null,
        private readonly mixed $apiDetail = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode, $previous);
    }

    public function getStatusCode(): int { return $this->statusCode; }
    public function getRequestId(): ?string { return $this->requestId; }
    public function getApiDetail(): mixed { return $this->apiDetail; }
}
