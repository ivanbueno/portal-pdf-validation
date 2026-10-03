import base64
import hashlib
import json
import pytest
from portal.auth import parse_principal
from portal.config import Settings
from fastapi import HTTPException


def principal(claims=None, auth_typ="aad"):
    claims = (
        claims
        if claims is not None
        else [("tid", "tenant"), ("oid", "person"), ("roles", "Validation.User"), ("name", "Staff Member")]
    )
    return base64.b64encode(
        json.dumps({"auth_typ": auth_typ, "claims": [{"typ": t, "val": v} for t, v in claims]}).encode()
    ).decode()


@pytest.fixture
def easy(client, settings):
    settings.dev_identity = False
    settings.auth_mode = "easyauth"
    settings.tenant_id = "tenant"
    return client


def test_server_session_and_stable_ownership(easy, settings):
    p = principal()
    expected = hashlib.sha256(b"tenant:user:person").hexdigest()
    assert parse_principal(p, settings).owner == expected
    response = easy.get("/api/session", headers={"x-ms-client-principal": p})
    assert response.json() == {"name": "Staff Member", "kind": "user"}
    assert easy.get("/api/config").json()["authMode"] == "easyauth"
    assert "clientId" not in easy.get("/api/config").json()


def test_mapped_claims_and_multiple_roles(easy, settings):
    p = principal(
        [
            ("http://schemas.microsoft.com/identity/claims/tenantid", "tenant"),
            ("http://schemas.microsoft.com/identity/claims/objectidentifier", "person"),
            ("http://schemas.microsoft.com/ws/2008/06/identity/claims/role", "OtherRole"),
            ("http://schemas.microsoft.com/ws/2008/06/identity/claims/role", "Validation.User"),
            ("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "Staff Member"),
        ]
    )
    assert parse_principal(p, settings) == parse_principal(principal(), settings)


@pytest.mark.parametrize(
    "encoded",
    [
        "not-base64",
        "",
        base64.b64encode(b"null").decode(),
        principal(auth_typ="google"),
        principal([("tid", "another-tenant"), ("oid", "person"), ("roles", "Validation.User")]),
        principal([("tid", "tenant"), ("oid", "first"), ("oid", "second"), ("roles", "Validation.User")]),
        principal([("tid", "tenant"), ("roles", "Validation.User")]),
    ],
)
def test_invalid_principal_rejected(easy, encoded):
    assert easy.get("/api/v1/documents", headers={"x-ms-client-principal": encoded}).status_code == 401


def test_no_header_or_bearer_fallback(easy):
    for headers in (
        {},
        {"Authorization": "Bearer unsigned-token"},
        {"x-ms-client-principal-id": "person", "x-ms-client-principal-name": "staff@example.com"},
    ):
        assert easy.get("/api/v1/documents", headers=headers).status_code == 401


def test_unconfigured_or_local_server_never_trusts_headers(easy, settings):
    settings.auth_mode = "disabled"
    assert easy.get("/api/session", headers={"x-ms-client-principal": principal()}).status_code == 401
    settings.auth_mode = "easyauth"
    settings.environment = "local"
    assert easy.get("/api/session", headers={"x-ms-client-principal": principal()}).status_code == 401


def test_cookie_csrf(easy):
    headers = {"x-ms-client-principal": principal()}
    body = {"name": "example.pdf", "size": 9}
    assert easy.post("/api/v1/documents", headers=headers, json=body).status_code == 403
    headers["X-Requested-With"] = "PDFValidationPortal"
    assert easy.post("/api/v1/documents", headers=headers, json=body).status_code == 201
    headers["Sec-Fetch-Site"] = "cross-site"
    assert easy.post("/api/v1/documents", headers=headers, json=body).status_code == 403


def test_application_permission_and_owner_namespace(easy, settings):
    claims = [("tid", "tenant"), ("oid", "person"), ("idtyp", "app"), ("roles", "Validation.Run")]
    app = parse_principal(principal(claims), settings)
    assert app.kind == "app"
    assert app.owner != parse_principal(principal(), settings).owner
    headers = {"x-ms-client-principal": principal(claims), "Authorization": "Bearer platform-validated-token"}
    assert (
        easy.post("/api/v1/documents", headers=headers, json={"name": "a.pdf", "size": 9}).status_code == 201
    )
    with pytest.raises(HTTPException) as error:
        parse_principal(principal(claims[:-1]), settings)
    assert error.value.status_code == 403


@pytest.mark.parametrize("scope_claim", ["scp", "http://schemas.microsoft.com/identity/claims/scope"])
def test_delegated_api_client_requires_both_permissions_and_keeps_ownership(easy, settings, scope_claim):
    p = principal(
        [
            ("tid", "tenant"),
            ("oid", "person"),
            ("roles", "Validation.User"),
            (scope_claim, "Other.Scope Validation.Access"),
        ]
    )
    assert parse_principal(p, settings).owner == parse_principal(principal(), settings).owner
    headers = {"x-ms-client-principal": p, "Authorization": "Bearer platform-validated-token"}
    assert easy.get("/api/v1/documents", headers=headers).status_code == 200
    assert (
        easy.post("/api/v1/documents", headers=headers, json={"name": "a.pdf", "size": 9}).status_code == 201
    )


@pytest.mark.parametrize("bearer_token", [False, True])
@pytest.mark.parametrize("scope_claim", ["scp", "http://schemas.microsoft.com/identity/claims/scope"])
@pytest.mark.parametrize(
    "roles,scope",
    [
        ([], "Validation.Access"),
        (["OtherRole"], "Validation.Access"),
        (["Validation.Run"], "Validation.Access"),
        (["Validation.User"], "Other.Scope"),
        (["Validation.User"], "Validation.Access.Extra"),
        (["Validation.User"], " "),
    ],
)
def test_delegated_scope_never_replaces_user_assignment(easy, roles, scope, scope_claim, bearer_token):
    claims = [("tid", "tenant"), ("oid", "person"), (scope_claim, scope)]
    claims += [("roles", role) for role in roles]
    headers = {"x-ms-client-principal": principal(claims)}
    if bearer_token:
        headers["Authorization"] = "Bearer platform-validated-token"
    assert easy.get("/api/v1/documents", headers=headers).status_code == 403
    assert easy.get("/api/session", headers=headers).status_code == 403
    # Supply the browser header too so a CSRF rejection cannot mask an authorization bypass.
    headers["X-Requested-With"] = "PDFValidationPortal"
    assert (
        easy.post("/api/v1/documents", headers=headers, json={"name": "a.pdf", "size": 9}).status_code == 403
    )


def test_role_only_user_bearer_cannot_use_browser_session_exception(easy):
    headers = {"x-ms-client-principal": principal(), "Authorization": "Bearer platform-validated-token"}
    assert easy.get("/api/v1/documents", headers=headers).status_code == 403
    del headers["Authorization"]
    assert easy.get("/api/v1/documents", headers=headers).status_code == 200


@pytest.mark.parametrize(
    "extra,status",
    [
        ([], 200),  # Application tokens without the optional idtyp claim remain supported.
        ([("idtyp", "user")], 403),
        ([("idtyp", "app"), ("scp", "Validation.Access")], 403),
        ([("scp", " ")], 403),
    ],
)
def test_application_role_cannot_bypass_delegated_requirements(easy, extra, status):
    claims = [("tid", "tenant"), ("oid", "client"), ("roles", "Validation.Run"), *extra]
    headers = {"x-ms-client-principal": principal(claims), "Authorization": "Bearer platform-validated-token"}
    assert easy.get("/api/v1/documents", headers=headers).status_code == status


def test_missing_permission_and_foreign_workspace(easy):
    p = principal([("tid", "tenant"), ("oid", "person")])
    assert easy.get("/api/v1/documents", headers={"x-ms-client-principal": p}).status_code == 403
    headers = {"x-ms-client-principal": principal(), "X-Requested-With": "PDFValidationPortal"}
    doc = easy.post("/api/v1/documents", headers=headers, json={"name": "a.pdf", "size": 9}).json()
    other = principal([("tid", "tenant"), ("oid", "other-person"), ("roles", "Validation.User")])
    assert (
        easy.get("/api/v1/documents/" + doc["id"], headers={"x-ms-client-principal": other}).status_code
        == 404
    )


def test_production_requires_explicit_trust_boundary():
    valid = dict(
        _env_file=None,
        environment="production",
        dev_identity=False,
        storage_connection_string="",
        tenant_id="tenant",
        audience="api",
        storage_account="account",
    )
    with pytest.raises(ValueError, match="Easy Auth"):
        Settings(**valid)
    assert Settings(**valid, auth_mode="easyauth").auth_mode == "easyauth"


@pytest.fixture
def pages(settings, tmp_path):
    (tmp_path / "index.html").write_text("workspace")
    settings.dist = tmp_path


def test_workspace_shell_is_public_and_holds_no_session(easy, pages):
    # The shell covers itself with the sign-in card; /api/session decides who gets in.
    unassigned = principal([("tid", "tenant"), ("oid", "person")])
    for headers in ({}, {"x-ms-client-principal": unassigned}, {"x-ms-client-principal": principal()}):
        response = easy.get("/", headers=headers, follow_redirects=False)
        assert (response.status_code, response.text) == (200, "workspace")
        assert response.headers["cache-control"] == "no-store"
    assert easy.get("/api/session").status_code == 401
    assert easy.get("/api/session", headers={"x-ms-client-principal": unassigned}).status_code == 403
    assert easy.get("/login", follow_redirects=False).status_code == 404


def test_local_identity_gets_workspace(client, pages):
    assert client.get("/", follow_redirects=False).text == "workspace"
