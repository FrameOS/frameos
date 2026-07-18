"""Config backups to a FrameOS Cloud provider (CLOUD-TODO Phase 3).

Two kinds ship in this phase, mirrored by the provider's /api/backends/backups
endpoints (docs/cloud-link.md):

- ``templates`` (scope ``backup:scenes``): the scene/template interchange zip.
  The kind string predates the templates→scenes rename and stays for protocol
  stability; every user-facing label says "scene".
- ``frames`` (scope ``backup:frames``): frame metadata + scene JSON. Local
  machine credentials (SSH, frame access, TLS, agent secrets) are stripped,
  while app API keys/tokens and configured upload headers are intentionally
  retained so restored scenes keep working. Asset backups (Phase 4) will be
  client-side encrypted instead.
"""
from __future__ import annotations

import base64
import datetime
import json
from typing import Any

from app.models.cloud import CloudBackendLink
from app.utils import cloud_link as cloud

FRAME_BACKUP_FORMAT = "frameos-frame-backup-v1"

# Top-level Frame.to_dict() fields that never leave the install.
SENSITIVE_FRAME_FIELDS = {
    "ssh_pass",
    "ssh_keys",
    "frame_access_key",
    "server_api_key",
    "frame_admin_auth",
    "https_proxy",  # contains TLS private keys
    "last_successful_deploy",  # a full nested snapshot incl. the same secrets
    "terminal_history",
}

# Key-name fragments scrubbed recursively from nested JSON blobs
# (network.wifiPassword, agent.agentSharedSecret, ...).
SENSITIVE_KEY_FRAGMENTS = ("password", "secret", "psk")


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _scrub(item)
            for key, item in value.items()
            if not any(fragment in key.lower() for fragment in SENSITIVE_KEY_FRAGMENTS)
        }
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def sanitize_frame_dict(frame_dict: dict) -> dict:
    """Frame metadata with machine credentials removed and app API keys kept."""
    cleaned = {key: value for key, value in frame_dict.items() if key not in SENSITIVE_FRAME_FIELDS}
    return _scrub(cleaned)


def frame_backup_payload(frame_dict: dict, project_name: str | None = None) -> dict:
    return {
        "format": FRAME_BACKUP_FORMAT,
        "saved_at": datetime.datetime.utcnow().isoformat(),
        "project_name": project_name,
        "frame": sanitize_frame_dict(frame_dict),
    }


def link_access_token(link: CloudBackendLink | None) -> str | None:
    if link is None or link.status != "connected":
        return None
    return cloud.decrypt_cloud_secret(link.access_token)


def cloud_headers_for_url(db, url: str | None) -> dict[str, str]:
    """Authorization header for requests that target the linked cloud provider.

    Lets template installs and repository refreshes fetch the account's
    private store scenes ("My cloud drive"); any other host gets no header, so
    the link token never leaks to third-party repositories.
    """
    if not url:
        return {}
    from app.models.cloud import current_cloud_backend_link

    link = current_cloud_backend_link(db)
    access_token = link_access_token(link)
    if link is None or access_token is None or not link.provider_url:
        return {}
    provider = link.provider_url.rstrip("/")
    if url == provider or url.startswith(provider + "/"):
        return {"authorization": f"Bearer {access_token}"}
    return {}


async def push_frame_backup(
    link: CloudBackendLink, access_token: str, frame_dict: dict, project_name: str | None = None
) -> tuple[int, dict]:
    payload = frame_backup_payload(frame_dict, project_name)
    content = json.dumps(payload).encode()
    return await cloud.backup_save(
        link.provider_url,
        access_token,
        {
            "kind": "frames",
            "item_key": f"frame-{frame_dict.get('id')}",
            "name": frame_dict.get("name") or f"Frame {frame_dict.get('id')}",
            "content_base64": base64.b64encode(content).decode(),
            "content_type": "application/json",
        },
    )


async def push_template_backup(
    link: CloudBackendLink, access_token: str, template_id: str, template_name: str | None, zip_bytes: bytes
) -> tuple[int, dict]:
    return await cloud.backup_save(
        link.provider_url,
        access_token,
        {
            "kind": "templates",
            "item_key": f"template-{template_id}",
            "name": template_name or "Template",
            "content_base64": base64.b64encode(zip_bytes).decode(),
            "content_type": "application/zip",
        },
    )
