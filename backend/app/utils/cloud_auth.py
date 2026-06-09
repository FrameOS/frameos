from __future__ import annotations

import base64
import datetime
import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from jose import JWTError, jwt

from app.config import DEFAULT_FRAMEOS_AUTH_PROVIDER_URL, config, normalize_frameos_auth_provider_url

CLOUD_OIDC_COOKIE_NAME = "frameos_cloud_oidc"
CLOUD_OIDC_COOKIE_MAX_AGE_SECONDS = 10 * 60
CLOUD_AUTH_SCOPES = ["openid", "profile", "email", "offline_access"]

_OIDC_DISCOVERY_CACHE: dict[str, tuple[datetime.datetime, "OidcDiscovery"]] = {}
_JWKS_CACHE: dict[str, tuple[datetime.datetime, dict[str, Any]]] = {}
_CACHE_TTL = datetime.timedelta(hours=1)


@dataclass(frozen=True)
class OidcDiscovery:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str


def cloud_provider_config(value: str | None = None) -> dict:
    if value is None:
        if config.FRAMEOS_AUTH_PROVIDER_DISABLED:
            return {"disabled": True, "provider_url": None}
        return normalize_frameos_auth_provider_url(config.FRAMEOS_AUTH_PROVIDER_URL or DEFAULT_FRAMEOS_AUTH_PROVIDER_URL)
    return normalize_frameos_auth_provider_url(value)


def _cloud_fernet() -> Fernet:
    digest = hashlib.sha256(config.SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_cloud_secret(value: str | None) -> str | None:
    if not value:
        return None
    return _cloud_fernet().encrypt(value.encode()).decode()


def decrypt_cloud_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _cloud_fernet().decrypt(value.encode()).decode()
    except (InvalidToken, UnicodeDecodeError):
        return None


def create_cloud_oidc_cookie_value(payload: dict[str, Any]) -> str:
    return _cloud_fernet().encrypt(json.dumps(payload).encode()).decode()


def decode_cloud_oidc_cookie_value(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        payload_raw = _cloud_fernet().decrypt(value.encode())
        payload = json.loads(payload_raw.decode())
    except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _cache_fresh(stored_at: datetime.datetime) -> bool:
    return datetime.datetime.utcnow() - stored_at < _CACHE_TTL


async def _request_json(
    method: str,
    url: str,
    *,
    http_client: httpx.AsyncClient | None = None,
    **kwargs,
) -> tuple[int, dict[str, Any]]:
    owns_client = http_client is None
    client = http_client or httpx.AsyncClient()
    try:
        response = await client.request(method, url, timeout=15.0, **kwargs)
        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = {}
        return response.status_code, payload if isinstance(payload, dict) else {}
    finally:
        if owns_client:
            await client.aclose()


async def discover_oidc_provider(provider_url: str, http_client: httpx.AsyncClient | None = None) -> OidcDiscovery:
    issuer = provider_url.rstrip("/")
    issuers = [issuer]
    if not issuer.endswith("/oidc"):
        issuers.append(f"{issuer}/oidc")

    last_error: Exception | None = None
    for candidate_issuer in issuers:
        cached = _OIDC_DISCOVERY_CACHE.get(candidate_issuer)
        if cached and _cache_fresh(cached[0]):
            return cached[1]

        discovery_url = f"{candidate_issuer}/.well-known/openid-configuration"
        try:
            status_code, metadata = await _request_json(
                "GET",
                discovery_url,
                http_client=http_client,
                headers={"accept": "application/json"},
            )
            if status_code < 200 or status_code >= 300:
                raise ValueError(f"OIDC discovery failed with status {status_code}")
            discovery = OidcDiscovery(
                issuer=str(metadata["issuer"]),
                authorization_endpoint=str(metadata["authorization_endpoint"]),
                token_endpoint=str(metadata["token_endpoint"]),
                jwks_uri=str(metadata["jwks_uri"]),
            )
        except Exception as exc:
            if cached:
                return cached[1]
            last_error = exc
            continue

        _OIDC_DISCOVERY_CACHE[candidate_issuer] = (datetime.datetime.utcnow(), discovery)
        return discovery

    if last_error:
        raise last_error
    raise ValueError("OIDC discovery failed")


async def fetch_jwks(jwks_uri: str, http_client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    cached = _JWKS_CACHE.get(jwks_uri)
    if cached and _cache_fresh(cached[0]):
        return cached[1]

    try:
        status_code, jwks = await _request_json(
            "GET",
            jwks_uri,
            http_client=http_client,
            headers={"accept": "application/json"},
        )
        if status_code < 200 or status_code >= 300:
            raise ValueError(f"JWKS fetch failed with status {status_code}")
        if not isinstance(jwks.get("keys"), list):
            raise ValueError("JWKS response is missing keys")
    except Exception:
        if cached:
            return cached[1]
        raise

    _JWKS_CACHE[jwks_uri] = (datetime.datetime.utcnow(), jwks)
    return jwks


async def verify_oidc_id_token(
    id_token: str,
    *,
    audience: str,
    discovery: OidcDiscovery,
    nonce: str,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    jwks = await fetch_jwks(discovery.jwks_uri, http_client=http_client)
    try:
        claims = jwt.decode(
            id_token,
            jwks,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            audience=audience,
            issuer=discovery.issuer,
        )
    except JWTError:
        raise

    if claims.get("nonce") != nonce:
        raise JWTError("OIDC id_token nonce mismatch")
    if not claims.get("sub"):
        raise JWTError("OIDC id_token is missing subject")
    return claims


def _base64_url_no_padding(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def create_pkce_pair() -> tuple[str, str]:
    verifier = _base64_url_no_padding(secrets.token_bytes(48))
    challenge = _base64_url_no_padding(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def random_urlsafe_token(byte_length: int = 32) -> str:
    return _base64_url_no_padding(secrets.token_bytes(byte_length))


def build_authorization_url(
    discovery: OidcDiscovery,
    *,
    client_id: str,
    code_challenge: str,
    nonce: str,
    redirect_uri: str,
    state: str,
    intent: str,
) -> str:
    extra_params = {"prompt": "create"} if intent == "signup" else {}
    query = {
        "client_id": client_id,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "nonce": nonce,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(CLOUD_AUTH_SCOPES),
        "state": state,
        **extra_params,
    }
    return f"{discovery.authorization_endpoint}?{urlencode(query)}"


async def exchange_authorization_code(
    discovery: OidcDiscovery,
    *,
    client_id: str,
    client_secret: str | None,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    body = {
        "client_id": client_id,
        "code": code,
        "code_verifier": code_verifier,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }
    auth = (client_id, client_secret) if client_secret else None
    status_code, token_set = await _request_json(
        "POST",
        discovery.token_endpoint,
        http_client=http_client,
        data=body,
        auth=auth,
        headers={"accept": "application/json", "content-type": "application/x-www-form-urlencoded"},
    )
    if status_code < 200 or status_code >= 300:
        raise ValueError(f"OIDC token exchange failed with status {status_code}")
    if not token_set.get("id_token"):
        raise ValueError("OIDC token response is missing id_token")
    return token_set


def provider_api_url(provider_url: str, path: str) -> str:
    return f"{provider_url.rstrip('/')}/{path.lstrip('/')}"


async def provider_json_request(
    method: str,
    provider_url: str,
    path: str,
    *,
    access_token: str | None = None,
    http_client: httpx.AsyncClient | None = None,
    json_body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {"accept": "application/json"}
    if json_body is not None:
        headers["content-type"] = "application/json"
    if access_token:
        headers["authorization"] = f"Bearer {access_token}"
    return await _request_json(
        method,
        provider_api_url(provider_url, path),
        http_client=http_client,
        headers=headers,
        json=json_body,
    )
