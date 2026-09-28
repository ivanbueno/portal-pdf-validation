<?php
declare(strict_types=1);

namespace PdfValidation\Tests;

use PdfValidation\AccessTokenProvider;
use PdfValidation\ApiException;
use PdfValidation\Client;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamFactoryInterface;
use Psr\Http\Message\StreamInterface;

final class ClientTest extends TestCase
{
    public function testCreateDocumentBuildsAuthenticatedJsonRequest(): void
    {
        $body = $this->createMock(StreamInterface::class);
        $body->method('__toString')->willReturn('{"name":"a.pdf"}');
        $request = $this->createMock(RequestInterface::class);
        $request->method('withHeader')->willReturnSelf();
        $request->method('withBody')->with($body)->willReturnSelf();
        $factory = $this->createMock(RequestFactoryInterface::class);
        $factory->expects(self::once())->method('createRequest')->with('POST', 'https://portal.example/api/v1/documents')->willReturn($request);
        $streams = $this->createMock(StreamFactoryInterface::class);
        $streams->expects(self::once())->method('createStream')->willReturn($body);
        $response = $this->response(201, '{"id":"doc-1"}');
        $http = $this->createMock(ClientInterface::class);
        $http->expects(self::once())->method('sendRequest')->with($request)->willReturn($response);
        $tokens = new class implements AccessTokenProvider { public function getAccessToken(): string { return 'secret-token'; } };

        $client = new Client('https://portal.example/', $http, $factory, $streams, $tokens);
        self::assertSame(['id' => 'doc-1'], $client->createDocument('a.pdf'));
    }

    public function testApiExceptionPreservesDetailAndRequestId(): void
    {
        $request = $this->createMock(RequestInterface::class);
        $factory = $this->createMock(RequestFactoryInterface::class);
        $factory->method('createRequest')->willReturn($request);
        $response = $this->response(404, '{"detail":"Missing"}', 'req-123');
        $http = $this->createMock(ClientInterface::class);
        $http->method('sendRequest')->willReturn($response);
        $tokens = new class implements AccessTokenProvider { public function getAccessToken(): string { return 'token'; } };
        $client = new Client('https://portal.example', $http, $factory, $this->createMock(StreamFactoryInterface::class), $tokens);

        try {
            $client->getStatus('gone');
            self::fail('Expected API exception.');
        } catch (ApiException $error) {
            self::assertSame(404, $error->getStatusCode());
            self::assertSame('req-123', $error->getRequestId());
            self::assertSame('Missing', $error->getApiDetail());
        }
    }

    public function testBlobUploadDoesNotForwardBearerToken(): void
    {
        $request = $this->createMock(RequestInterface::class);
        $request->expects(self::once())->method('withBody')->willReturnSelf();
        $seenHeaders = [];
        $request->method('withHeader')->willReturnCallback(static function (string $name, string $value) use ($request, &$seenHeaders): RequestInterface {
            self::assertNotSame('Authorization', $name);
            $seenHeaders[$name] = $value;
            return $request;
        });
        $factory = $this->createMock(RequestFactoryInterface::class);
        $factory->expects(self::once())->method('createRequest')->with('PUT', 'https://blob.example/grant')->willReturn($request);
        $streams = $this->createMock(StreamFactoryInterface::class);
        $streams->expects(self::never())->method('createStream');
        $http = $this->createMock(ClientInterface::class);
        $http->expects(self::once())->method('sendRequest')->with($request)->willReturn($this->response(201, ''));
        $tokens = new class implements AccessTokenProvider {
            public function getAccessToken(): string { throw new \LogicException('Blob upload must not request an API token.'); }
        };
        $client = new Client('https://portal.example', $http, $factory, $streams, $tokens);
        $client->uploadFile($this->createMock(StreamInterface::class), 'https://blob.example/grant');
        self::assertSame(['x-ms-blob-type' => 'BlockBlob', 'Content-Type' => 'application/pdf'], $seenHeaders);
    }

    private function response(int $status, string $content, string $requestId = ''): ResponseInterface
    {
        $body = $this->createMock(StreamInterface::class);
        $body->method('__toString')->willReturn($content);
        $response = $this->createMock(ResponseInterface::class);
        $response->method('getStatusCode')->willReturn($status);
        $response->method('getBody')->willReturn($body);
        $response->method('getHeaderLine')->with('X-Request-ID')->willReturn($requestId);
        return $response;
    }
}
