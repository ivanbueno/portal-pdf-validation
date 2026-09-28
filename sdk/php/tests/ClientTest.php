<?php
declare(strict_types=1);

namespace PdfValidation\Tests;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Psr7\Utils;
use PdfValidation\AccessTokenProvider;
use PdfValidation\ApiException;
use PdfValidation\Client;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    public function testCreateDocumentSendsAuthenticatedJson(): void
    {
        [$http, $history] = $this->http([new Response(201, [], '{"id":"doc-1"}')]);
        $client = new Client('https://portal.example', $http, $this->token());

        self::assertSame(['id' => 'doc-1'], $client->createDocument('a.pdf', 12, ['wcag'], 'key-1'));
        $request = $history[0]['request'];
        self::assertSame('POST', $request->getMethod());
        self::assertSame('/api/v1/documents', $request->getUri()->getPath());
        self::assertSame('Bearer test-token', $request->getHeaderLine('Authorization'));
        self::assertSame('key-1', $request->getHeaderLine('Idempotency-Key'));
        self::assertSame(['name' => 'a.pdf', 'size' => 12, 'profiles' => ['wcag']], json_decode((string) $request->getBody(), true));
    }

    public function testBlobUploadDoesNotForwardBearerToken(): void
    {
        [$http, $history] = $this->http([new Response(201)]);
        $client = new Client('https://portal.example', $http, $this->token());

        $client->uploadFile(Utils::streamFor('pdf'), 'https://blob.example/grant');
        $request = $history[0]['request'];
        self::assertSame('PUT', $request->getMethod());
        self::assertSame('BlockBlob', $request->getHeaderLine('x-ms-blob-type'));
        self::assertSame('application/pdf', $request->getHeaderLine('Content-Type'));
        self::assertSame('', $request->getHeaderLine('Authorization'));
    }

    public function testApiExceptionPreservesDetailAndRequestId(): void
    {
        [$http] = $this->http([new Response(404, ['X-Request-ID' => 'req-123'], '{"detail":"Missing"}')]);
        $client = new Client('https://portal.example', $http, $this->token());

        try {
            $client->getStatus('gone');
            self::fail('Expected API exception.');
        } catch (ApiException $error) {
            self::assertSame(404, $error->getStatusCode());
            self::assertSame('req-123', $error->getRequestId());
            self::assertSame('Missing', $error->getApiDetail());
        }
    }

    private function http(array $responses): array
    {
        $history = [];
        $stack = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($history));
        return [new GuzzleClient(['handler' => $stack]), &$history];
    }

    private function token(): AccessTokenProvider
    {
        return new class implements AccessTokenProvider {
            public function getAccessToken(): string { return 'test-token'; }
        };
    }
}
