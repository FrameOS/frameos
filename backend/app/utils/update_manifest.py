"""Where this backend reads the update manifest from (docs/auto-updates.md
"Where it lives, and who serves it"), and the cohort key it gives its frames.

GitHub first (``docs/update-manifest.json`` on ``main``: the host a backend
already trusts for releases), FrameOS Cloud's mirror when GitHub does not
answer, and nothing when neither does: no manifest, no automatic update.
``FRAMEOS_UPDATE_MANIFEST_URL`` replaces the GitHub URL (a test server, a
fork). The copy is cached in process; the last good one outlives a failure.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any, Optional

import httpx

from app.config import config

GITHUB_MANIFEST_URL = "https://raw.githubusercontent.com/FrameOS/frameos/main/docs/update-manifest.json"
CLOUD_MANIFEST_URL = "https://cloud.frameos.net/api/updates/manifest"
MANIFEST_URL_ENV = "FRAMEOS_UPDATE_MANIFEST_URL"

MANIFEST_CACHE_SECONDS = 600
MANIFEST_FAILURE_CACHE_SECONDS = 60
# A manifest is a few KB; a body past this is not one.
MAX_MANIFEST_BYTES = 1024 * 1024

_cache: dict[str, Any] = {"at": 0.0, "manifest": None, "ok": False}


def clear_update_manifest_cache() -> None:
    """Reset the in-process copy (tests)."""
    _cache["at"] = 0.0
    _cache["manifest"] = None
    _cache["ok"] = False


def update_manifest_urls() -> list[str]:
    primary = (os.environ.get(MANIFEST_URL_ENV) or "").strip() or GITHUB_MANIFEST_URL
    return [primary] if primary == CLOUD_MANIFEST_URL else [primary, CLOUD_MANIFEST_URL]


async def _fetch_manifest(url: str) -> Optional[dict[str, Any]]:
    """One source's manifest, or None. Tests patch this."""
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or len(response.content) > MAX_MANIFEST_BYTES:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("releases"), list):
        return None
    return payload


async def get_update_manifest() -> Optional[dict[str, Any]]:
    """The manifest, or None when no source answered and no earlier copy
    was ever read."""
    now = time.monotonic()
    ttl = MANIFEST_CACHE_SECONDS if _cache["ok"] else MANIFEST_FAILURE_CACHE_SECONDS
    if _cache["at"] and now - _cache["at"] < ttl:
        return _cache["manifest"]
    manifest: Optional[dict[str, Any]] = None
    for url in update_manifest_urls():
        manifest = await _fetch_manifest(url)
        if manifest is not None:
            break
    _cache["at"] = now
    if manifest is not None:
        _cache["manifest"] = manifest
        _cache["ok"] = True
    else:
        # Keep the last good copy; ask again sooner.
        _cache["ok"] = False
    return _cache["manifest"]


def backend_frame_key(frame_id: int) -> str:
    """``backend:<sha256(SECRET_KEY)[:12]>:<frame id>``: stable for this
    install, so frame 1 of every backend is not one cohort, and nothing of
    the secret leaves it."""
    secret = str(getattr(config, "SECRET_KEY", "") or "")
    install = hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]
    return f"backend:{install}:{int(frame_id)}"
