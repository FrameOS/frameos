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
