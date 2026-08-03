"""Client helpers for the FrameOS Cloud link protocol.

The protocol is documented in docs/cloud-link.md. It is a plain OAuth 2.0
Device Authorization Grant (RFC 8628) against a user-configurable provider,
so any server implementing the documented contract works — not just
cloud.frameos.net.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.config import config

DEFAULT_CLOUD_PROVIDER_URL = "https://cloud.frameos.net"

# Scopes requested by default when linking a backend: the link itself plus the
# features included with every cloud account (backups, saving and sharing
# scenes). Security-sensitive scopes (auth:login, remote:access, ...) are only
# requested later, when the user explicitly toggles the matching feature on.
DEFAULT_LINK_SCOPES = [
    "backend:link",
    "backend:read",
    "backup:scenes",
    "backup:frames",
    "store:publish",
]

REQUEST_TIMEOUT_SECONDS = 15.0


def _is_local_host(hostname: str) -> bool:
    """Hosts where plain HTTP cannot be intercepted by a third party in any
    meaningful sense: the machine itself, the local network, or mDNS names."""
    host = (hostname or "").strip().lower().strip("[]")
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def normalize_cloud_provider_url(value: str | None) -> str | None:
    """Return a normalized origin URL, None when disabled, raise on garbage.

    Plain HTTP is refused for anything but a local host. Everything that
    matters rides this connection — the link bearer token, grant state, and the
    identity claims a cloud login is minted from — so on http:// an on-path
    attacker can forge a revocation, or forge the claims that decide who gets
    logged in. Self-hosted providers on the LAN or on loopback keep working.
    """
    normalized = (value or "").strip()
    if normalized.lower() == "disabled":
        return None
    if not normalized:
        return DEFAULT_CLOUD_PROVIDER_URL
    parsed = urlparse(normalized)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(
            "The FrameOS Cloud server must be a full http(s) URL, including the "
            "scheme — e.g. https://cloud.frameos.net"
        )
    if parsed.scheme == "http" and not _is_local_host(parsed.hostname or ""):
        raise ValueError(
            "The FrameOS Cloud server must use https (http is allowed only for "
            "localhost and local network addresses)"
        )
    path = parsed.path.rstrip("/")
    return parsed._replace(path=path, params="", query="", fragment="").geturl().rstrip("/")


def hash_setup_claim(claim: str) -> str:
    """First-run setup claim cookies are stored hashed: the row is readable by
    anything that can read the database, and the cookie value is what proves
    ownership of a pending link."""
    return hashlib.sha256(claim.encode()).hexdigest()


def default_cloud_provider_url() -> str | None:
    """The provider URL from the environment, None when cloud is disabled."""
    return normalize_cloud_provider_url(config.FRAMEOS_CLOUD_URL)


def _fernet_for(key: str) -> Fernet:
    digest = hashlib.sha256(key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def cloud_secret_keys() -> list[str]:
    """Keys that may decrypt stored cloud secrets, newest first.

    The first entry also encrypts. By default that is SECRET_KEY, so nothing
    changes for existing installs — but rotating SECRET_KEY would otherwise
    make every stored link token undecryptable, leaving the link dead while it
    still reported "connected". Two escape hatches:

    - CLOUD_SECRET_KEY pins cloud secrets to their own key, so SECRET_KEY can
      be rotated freely without touching them.
    - PREVIOUS_SECRET_KEYS (comma separated) are tried on decrypt only, so a
      rotation can be rolled out without re-linking. Secrets are re-encrypted
      with the current key as they are read (see rewrap_cloud_secret), so the
      old keys can be dropped once every link has synced.
    """
    keys: list[str] = []
    for candidate in (config.CLOUD_SECRET_KEY, config.SECRET_KEY, *config.PREVIOUS_SECRET_KEYS):
        if candidate and candidate not in keys:
            keys.append(candidate)
    return keys


def encrypt_cloud_secret(value: str | None) -> str | None:
    if not value:
        return None
    return _fernet_for(cloud_secret_keys()[0]).encrypt(value.encode()).decode()


def decrypt_cloud_secret(value: str | None) -> str | None:
    if not value:
        return None
    for key in cloud_secret_keys():
        try:
            return _fernet_for(key).decrypt(value.encode()).decode()
        except (InvalidToken, UnicodeDecodeError):
            continue
    return None


def rewrap_cloud_secret(value: str | None) -> str | None:
    """Re-encrypt a secret under the current key, or None if already current.

    Lets a caller that holds a database session migrate stored secrets after a
    key change, without asking the user to re-link.
    """
    if not value:
        return None
    keys = cloud_secret_keys()
    try:
        _fernet_for(keys[0]).decrypt(value.encode())
        return None  # already encrypted with the current key
    except (InvalidToken, UnicodeDecodeError):
        pass
    plaintext = decrypt_cloud_secret(value)
    if plaintext is None:
        return None
    return encrypt_cloud_secret(plaintext)


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


# ---- login handoff -----------------------------------------------------------


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


# ---- config backups ----------------------------------------------------------


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
    """The account's own store scenes ("Private cloud scenes"), private ones included."""
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
