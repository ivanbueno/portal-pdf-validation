import pytest
from fastapi.testclient import TestClient
from portal.app import create_app, content_security_policy


@pytest.fixture
def static_client(settings, store, tmp_path):
    settings.dist = tmp_path
    assets = tmp_path / "assets"
    assets.mkdir()
    (tmp_path / "index.html").write_text("<html>Workspace</html>")
    for name in ("app-Abcd123_.js", "main-aBcD1234.css", "pdf.worker.min-Zyxw9876.mjs", "plain.js"):
        (assets / name).write_text("example asset")
    return TestClient(create_app(settings, store))


@pytest.mark.parametrize("name", ["app-Abcd123_.js", "main-aBcD1234.css", "pdf.worker.min-Zyxw9876.mjs"])
def test_hashed_assets_are_immutable_including_conditional_requests(static_client, name):
    url = "/assets/" + name
    response = static_client.get(url)
    assert response.status_code == 200
    expected = "public, max-age=31536000, immutable"
    assert response.headers["cache-control"] == expected
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-request-id"]
    assert static_client.head(url).headers["cache-control"] == expected
    conditional = static_client.get(url, headers={"If-None-Match": response.headers["etag"]})
    assert conditional.status_code == 304
    assert conditional.headers["cache-control"] == expected


@pytest.mark.parametrize(
    "url,status",
    [
        ("/", 200),
        ("/api/config", 200),
        ("/api/session", 200),
        ("/api/v1/documents", 200),
        ("/assets/plain.js", 200),
        ("/assets/missing-Abcd1234.js", 404),
    ],
)
def test_shell_api_and_nonversioned_or_missing_assets_are_not_cached(static_client, url, status):
    response = static_client.get(url)
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"


def test_hashed_asset_errors_are_not_cached(static_client):
    response = static_client.post("/assets/app-Abcd123_.js")
    assert response.status_code == 405
    assert response.headers["cache-control"] == "no-store"


def directives(response):
    return {
        name: values
        for directive in response.headers["content-security-policy"].split(";")
        for name, *values in [directive.split()]
    }


@pytest.mark.parametrize("url", ["/", "/api/config", "/assets/app-Abcd123_.js", "/missing"])
def test_response_policy_blocks_framing_and_active_content(static_client, url):
    response = static_client.get(url)
    policy = directives(response)
    assert response.headers["x-frame-options"] == "DENY"
    assert policy["default-src"] == ["'self'"]
    assert policy["frame-ancestors"] == policy["object-src"] == ["'none'"]
    assert policy["worker-src"] == policy["base-uri"] == policy["form-action"] == ["'self'"]
    assert policy["img-src"] == policy["font-src"] == ["'self'", "data:"]
    assert "'unsafe-inline'" not in response.headers["content-security-policy"]
    assert "'unsafe-eval'" not in response.headers["content-security-policy"]
    assert "strict-transport-security" not in response.headers  # Local HTTP remains usable.


@pytest.mark.parametrize(
    "settings_values,expected",
    [
        ({"storage_account": "portaltest"}, "https://portaltest.blob.core.windows.net"),
        (
            {"storage_account": "portaltest", "public_blob_endpoint": "https://uploads.example.test/base"},
            "https://uploads.example.test",
        ),
        (
            {
                "storage_connection_string": "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;AccountKey=secret"
            },
            "http://127.0.0.1:10000",
        ),
        (
            {
                "storage_connection_string": "DefaultEndpointsProtocol=https;AccountName=portal;AccountKey=secret"
            },
            "https://portal.blob.core.windows.net",
        ),
    ],
)
def test_csp_allows_only_the_configured_upload_origin(settings, store, settings_values, expected):
    for key, value in settings_values.items():
        setattr(settings, key, value)
    client = TestClient(create_app(settings, store))
    assert directives(client.get("/api/config"))["connect-src"] == ["'self'", expected]


@pytest.mark.parametrize(
    "endpoint", ["https://storage.test;evil.test", "https://storage.test 'unsafe-eval'", "data:bad"]
)
def test_invalid_upload_origin_cannot_relax_csp(settings, endpoint):
    settings.public_blob_endpoint = endpoint
    with pytest.raises(ValueError, match="Invalid Blob endpoint"):
        content_security_policy(settings)


@pytest.mark.parametrize("failure", ["unauthorized", "body_limit", "unexpected", "not_found"])
def test_production_errors_keep_security_headers(settings, store, monkeypatch, failure):
    settings.environment = "production"
    settings.auth_mode = "easyauth"
    client = TestClient(create_app(settings, store), raise_server_exceptions=False)
    if failure == "unauthorized":
        response = client.get("/api/session")
        assert response.status_code == 401
    elif failure == "body_limit":
        response = client.post("/api/v1/documents", content=b"x" * (256 * 1024 + 1))
        assert response.status_code == 413
    elif failure == "unexpected":
        # An exception outside the route handlers uses the outer 500 handler.
        monkeypatch.setattr(store, "container", None, raising=False)
        response = client.get("/health/ready")
        assert response.status_code == 500
    else:
        response = client.get("/missing")
        assert response.status_code == 404
    assert response.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"
    assert response.headers["x-frame-options"] == "DENY"
    assert directives(response)["frame-ancestors"] == ["'none'"]
    assert directives(response)["default-src"] == ["'self'"]


def test_production_shell_and_cached_assets_send_hsts(static_client, settings):
    settings.environment = "production"
    asset = static_client.get("/assets/app-Abcd123_.js")
    cached = static_client.get("/assets/app-Abcd123_.js", headers={"If-None-Match": asset.headers["etag"]})
    assert cached.status_code == 304
    for response in (static_client.get("/"), asset, cached):
        assert response.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"
        assert directives(response)["frame-ancestors"] == ["'none'"]


def test_cdn_documentation_is_only_available_outside_production(settings, store):
    local = TestClient(create_app(settings, store))
    assert local.get("/docs").status_code == local.get("/redoc").status_code == 200
    settings.environment = "production"
    production = TestClient(create_app(settings, store))
    assert production.get("/docs").status_code == production.get("/redoc").status_code == 404
    assert production.get("/openapi.json").status_code == 200
