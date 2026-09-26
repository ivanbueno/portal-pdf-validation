"""Authorization from Azure Easy Auth's platform-injected principal.

These headers are trusted ONLY behind the enabled Container Apps auth sidecar.
Never expose the application port through a separate ingress/proxy in production.
Signature, issuer, audience and session validation belong to Easy Auth, not this module.
"""

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer

bearer = HTTPBearer(
    auto_error=False,
    description="Entra access token validated by Azure Easy Auth. Browsers use its session cookie.",
)
CLAIMS = {
    "tid": ("tid", "http://schemas.microsoft.com/identity/claims/tenantid"),
    "oid": ("oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"),
    "scp": ("scp", "http://schemas.microsoft.com/identity/claims/scope"),
    "roles": ("roles", "role", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"),
    "name": ("name", "preferred_username", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"),
    "idtyp": ("idtyp",),
}
# Owner of every document created under the explicit local development identity.
LOCAL_OWNER = "local-development"


@dataclass(frozen=True)
class Identity:
    owner: str
    name: str
    kind: str


def parse_principal(encoded, settings):
    try:
        if not encoded or len(encoded) > 65536:
            raise ValueError()
        principal = json.loads(base64.b64decode(encoded, validate=True))
        if not isinstance(principal, dict) or principal.get("auth_typ") != "aad":
            raise ValueError()
        claims = principal.get("claims")
        if not isinstance(claims, list) or not all(
            isinstance(c, dict) and isinstance(c.get("typ"), str) and isinstance(c.get("val"), str)
            for c in claims
        ):
            raise ValueError()
        values = {key: {c["val"] for c in claims if c["typ"] in aliases} for key, aliases in CLAIMS.items()}
        if values["tid"] != {settings.tenant_id} or len(values["oid"]) != 1:
            raise ValueError()
        subject = next(iter(values["oid"]))
        if not subject:
            raise ValueError()
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
        raise HTTPException(401, "Missing or invalid Easy Auth principal")
    scopes = {scope for claim in values["scp"] for scope in claim.split()}
    roles = values["roles"]
    if values["idtyp"] == {"app"} or (
        settings.app_role in roles and not scopes and settings.user_role not in roles
    ):
        if settings.app_role not in roles:
            raise HTTPException(403, "Application requires the Validation.Run role")
        kind = "app"
    elif settings.user_role in roles or settings.scope in scopes:
        kind = "user"
    else:
        raise HTTPException(403, "User requires the Validation.User role or Validation.Access scope")
    owner_id = hashlib.sha256(f"{settings.tenant_id}:{kind}:{subject}".encode()).hexdigest()
    return Identity(owner_id, next(iter(sorted(values["name"])), "Signed in"), kind)


def identity(request: Request, credentials=Depends(bearer)):
    settings = request.app.state.settings
    if settings.dev_identity and settings.environment in {"local", "test"}:
        return Identity(LOCAL_OWNER, "Local workspace", "user")
    # Standalone local servers never trust user-supplied Azure headers.
    if settings.auth_mode != "easyauth" or settings.environment not in {"production", "test"}:
        raise HTTPException(401, "Easy Auth is not configured")
    principal = parse_principal(request.headers.get("x-ms-client-principal"), settings)
    if request.method not in {"GET", "HEAD", "OPTIONS"} and credentials is None:
        # A non-simple header + no cross-origin API CORS prevents cookie-based CSRF.
        # Bearer callers are already validated by Easy Auth and need no browser header.
        if (
            request.headers.get("x-requested-with") != "PDFValidationPortal"
            or request.headers.get("sec-fetch-site") == "cross-site"
        ):
            raise HTTPException(403, "Same-origin browser request required")
    return principal


def owner(principal: Identity = Depends(identity)):
    return principal.owner
