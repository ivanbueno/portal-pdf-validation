import pytest
from fastapi.testclient import TestClient
from portal.app import create_app


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
