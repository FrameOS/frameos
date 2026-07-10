"""Client helpers for the FrameOS Cloud link protocol.

The protocol is documented in docs/cloud-link.md. It is a plain OAuth 2.0
Device Authorization Grant (RFC 8628) against a user-configurable provider,
so any server implementing the documented contract works — not just
cloud.frameos.net.
"""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.config import config

DEFAULT_CLOUD_PROVIDER_URL = "https://cloud.frameos.net"

# Scopes requested by default when linking a backend. Kept to the minimum the
# link itself needs; feature scopes (auth:login, store:read, ...) are requested
# later, when the user enables the matching feature.
DEFAULT_LINK_SCOPES = ["backend:link", "backend:read"]

REQUEST_TIMEOUT_SECONDS = 15.0


def normalize_cloud_provider_url(value: str | None) -> str | None:
    """Return a normalized origin URL, None when disabled, raise on garbage."""
    normalized = (value or "").strip()
    if normalized.lower() == "disabled":
        return None
    if not normalized:
        return DEFAULT_CLOUD_PROVIDER_URL
    parsed = urlparse(normalized)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("The FrameOS Cloud server must be an http(s) URL")
    path = parsed.path.rstrip("/")
    return parsed._replace(path=path, params="", query="", fragment="").geturl().rstrip("/")


def default_cloud_provider_url() -> str | None:
    """The provider URL from the environment, None when cloud is disabled."""
    return normalize_cloud_provider_url(config.FRAMEOS_CLOUD_URL)


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


def cloud_api_url(provider_url: str, path: str) -> str:
    return f"{provider_url.rstrip('/')}/{path.lstrip('/')}"


async def cloud_request(
    method: str,
    provider_url: str,
    path: str,
    *,
    access_token: str | None = None,
    json_body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """One JSON request to the cloud provider. Returns (status_code, payload)."""
    headers = {"accept": "application/json"}
    if access_token:
        headers["authorization"] = f"Bearer {access_token}"
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.request(
            method,
            cloud_api_url(provider_url, path),
            headers=headers,
            json=json_body,
        )
    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = {}
    return response.status_code, payload if isinstance(payload, dict) else {}


async def device_start(provider_url: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return await cloud_request("POST", provider_url, "/api/device/start", json_body=payload)


async def device_poll(provider_url: str, device_code: str) -> tuple[int, dict[str, Any]]:
    return await cloud_request("POST", provider_url, "/api/device/poll", json_body={"device_code": device_code})


async def backend_inventory(
    provider_url: str, access_token: str, payload: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "POST", provider_url, "/api/backends/inventory", access_token=access_token, json_body=payload
    )


async def backend_grants(provider_url: str, access_token: str) -> tuple[int, dict[str, Any]]:
    return await cloud_request("GET", provider_url, "/api/backends/grants", access_token=access_token)


async def backend_unlink(provider_url: str, access_token: str) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "POST", provider_url, "/api/backends/unlink", access_token=access_token, json_body={}
    )


async def backend_rotate_token(provider_url: str, access_token: str) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "POST", provider_url, "/api/backends/rotate-token", access_token=access_token, json_body={}
    )


async def backend_set_scopes(
    provider_url: str, access_token: str, scopes: list[str]
) -> tuple[int, dict[str, Any]]:
    """Change the link's enabled features in place. Removals apply directly
    ("status": "updated"); additions come back as "approval_required" with a
    device code to poll while the owner approves on the provider."""
    return await cloud_request(
        "POST", provider_url, "/api/backends/scopes", access_token=access_token, json_body={"scopes": scopes}
    )


# ---- login handoff (Phase 1) -------------------------------------------------


async def frameos_login_start(
    provider_url: str, access_token: str, payload: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    """Ask the provider for an authorization URL for a browser login handoff."""
    return await cloud_request(
        "POST", provider_url, "/api/frameos/login/start", access_token=access_token, json_body=payload
    )


async def frameos_login_token(
    provider_url: str, access_token: str, code: str
) -> tuple[int, dict[str, Any]]:
    """Redeem the single-use code from the login callback for identity claims."""
    return await cloud_request(
        "POST", provider_url, "/api/frameos/login/token", access_token=access_token, json_body={"code": code}
    )


# ---- config backups (Phase 3) ------------------------------------------------


async def backup_list(provider_url: str, access_token: str) -> tuple[int, dict[str, Any]]:
    return await cloud_request("GET", provider_url, "/api/backends/backups", access_token=access_token)


async def backup_save(
    provider_url: str, access_token: str, payload: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "POST", provider_url, "/api/backends/backups", access_token=access_token, json_body=payload
    )


async def backup_get(
    provider_url: str, access_token: str, backup_id: str
) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "GET", provider_url, f"/api/backends/backups/{backup_id}", access_token=access_token
    )


async def backup_delete(
    provider_url: str, access_token: str, backup_id: str
) -> tuple[int, dict[str, Any]]:
    return await cloud_request(
        "DELETE", provider_url, f"/api/backends/backups/{backup_id}", access_token=access_token
    )


# ---- store (scene publishing) --------------------------------------------------


async def store_publish(
    provider_url: str, access_token: str, payload: dict[str, Any]
) -> tuple[int, dict[str, Any]]:
    """Publish a scene (template zip) to the cloud store (store:publish)."""
    return await cloud_request(
        "POST", provider_url, "/api/store/publish", access_token=access_token, json_body=payload
    )


async def store_drive(provider_url: str, access_token: str) -> tuple[int, dict[str, Any]]:
    """The account's own store scenes ("My cloud drive"), private ones included."""
    return await cloud_request(
        "GET", provider_url, "/api/store/account/repository.json", access_token=access_token
    )


async def cloud_get_binary(provider_url: str, path: str, access_token: str) -> tuple[int, str, bytes]:
    """One authenticated binary GET (preview images, zips). Returns (status, content_type, body)."""
    headers = {"authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.get(cloud_api_url(provider_url, path), headers=headers)
    return (
        response.status_code,
        response.headers.get("content-type", "application/octet-stream"),
        response.content,
    )
