"""Config backups to a FrameOS Cloud provider (CLOUD-TODO Phase 3).

Two kinds ship in this phase, mirrored by the provider's /api/backends/backups
endpoints (docs/cloud-link.md):

- ``templates`` (scope ``backup:scenes``): the scene/template interchange zip.
  The kind string predates the templates→scenes rename and stays for protocol
  stability; every user-facing label says "scene".
- ``frames`` (scope ``backup:frames``): frame metadata + scene JSON.

Every payload is sealed with the account's backup key (app/utils/backup_crypto)
before upload — the provider stores ciphertext it cannot read, next to a small
curated plaintext manifest so listings stay useful. Because payloads are
encrypted, user-level secrets (wifi passwords, mountpoint credentials, app API
keys, upload headers) are *kept* so a restore actually works. Only per-install
machine credentials are stripped: they are regenerated or re-entered on
restore and would be useless on another install anyway.
"""
from __future__ import annotations

import base64
import datetime
import json

from sqlalchemy.orm import Session

from app.models.cloud import CloudBackendLink
from app.utils import backup_crypto
from app.utils import cloud_link as cloud

FRAME_BACKUP_FORMAT = "frameos-frame-backup-v1"
ENCRYPTED_BACKUP_FORMAT = "frameos-encrypted-backup-v1"

# Top-level Frame.to_dict() fields that never leave the install: per-install
# machine credentials, regenerated or re-entered locally on restore.
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


def sanitize_frame_dict(frame_dict: dict) -> dict:
    """Frame metadata minus per-install machine credentials. Everything else —
    scenes (including their ``secret: true`` field markers and app API keys),
    wifi and mountpoint credentials, upload headers — is kept: the payload is
    sealed with the backup key before it leaves this install. The agent shared
    secret is dropped because a restore always regenerates it."""
    cleaned = {key: value for key, value in frame_dict.items() if key not in SENSITIVE_FRAME_FIELDS}
    agent = cleaned.get("agent")
    if isinstance(agent, dict) and "agentSharedSecret" in agent:
        cleaned["agent"] = {key: value for key, value in agent.items() if key != "agentSharedSecret"}
    return cleaned


def frame_backup_payload(frame_dict: dict, project_name: str | None = None) -> dict:
    return {
        "format": FRAME_BACKUP_FORMAT,
        "saved_at": datetime.datetime.utcnow().isoformat(),
        "project_name": project_name,
        "frame": sanitize_frame_dict(frame_dict),
    }


def frame_backup_manifest(frame_dict: dict, project_name: str | None) -> dict:
    """The curated plaintext part of an encrypted frame backup: enough to know
    what you are restoring, never the configuration itself."""
    scenes = frame_dict.get("scenes") or []
    return {
        "name": frame_dict.get("name"),
        "project_name": project_name,
        "device": frame_dict.get("device"),
        "width": frame_dict.get("width"),
        "height": frame_dict.get("height"),
        "scenes": [scene.get("name") for scene in scenes if isinstance(scene, dict)],
        "frameos_version": frame_dict.get("version"),
    }


def link_access_token(link: CloudBackendLink | None) -> str | None:
    if link is None or link.status != "connected":
        return None
    return cloud.decrypt_cloud_secret(link.access_token)


def cloud_headers_for_url(db, url: str | None) -> dict[str, str]:
    """Authorization header for requests that target the linked cloud provider.

    Lets template installs and repository refreshes fetch the account's
    private store scenes ("Private cloud scenes"); any other host gets no
    header, so the link token never leaks to third-party repositories.
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


# ---- backup key management ----------------------------------------------------


def link_backup_private_key(link: CloudBackendLink | None) -> bytes | None:
    if link is None or not link.backup_private_key:
        return None
    decrypted = cloud.decrypt_cloud_secret(link.backup_private_key)
    if decrypted is None:
        # Undecryptable with any configured key (SECRET_KEY rotated without
        # PREVIOUS_SECRET_KEYS / CLOUD_SECRET_KEY) — same failure mode the
        # sync loop reports for the link token.
        return None
    return base64.b64decode(decrypted)


def set_link_backup_key(link: CloudBackendLink, private_key: bytes) -> None:
    link.backup_private_key = cloud.encrypt_cloud_secret(base64.b64encode(private_key).decode())
    link.backup_key_fingerprint = backup_crypto.backup_key_fingerprint(private_key)


def ensure_backup_key(db: Session, link: CloudBackendLink) -> bytes:
    """The account backup key, generated on first use. The backend keeps the
    private key (it already stores every secret in plaintext) so day-to-day
    backups and restores stay transparent; the user saves the recovery code
    for the reinstall case."""
    private_key = link_backup_private_key(link)
    if private_key is not None:
        return private_key
    private_key = backup_crypto.generate_backup_private_key()
    set_link_backup_key(link, private_key)
    db.commit()
    return private_key


# ---- sealed envelopes ----------------------------------------------------------


def encrypted_backup_content(private_key: bytes, inner: bytes, meta: dict) -> bytes:
    """Wrap payload bytes into the uploaded envelope: plaintext manifest +
    sealed ciphertext, stamped with the key fingerprint."""
    envelope = {
        "format": ENCRYPTED_BACKUP_FORMAT,
        "key_fingerprint": backup_crypto.backup_key_fingerprint(private_key),
        "saved_at": datetime.datetime.utcnow().isoformat(),
        "meta": meta,
        "sealed_base64": base64.b64encode(
            backup_crypto.seal(backup_crypto.backup_public_key(private_key), inner)
        ).decode(),
    }
    return json.dumps(envelope).encode()


def parse_encrypted_backup(content: bytes) -> dict | None:
    """The envelope dict when ``content`` is an encrypted backup, else None
    (legacy plaintext backups from before encryption shipped)."""
    try:
        envelope = json.loads(content)
    except (TypeError, ValueError):
        return None
    if isinstance(envelope, dict) and envelope.get("format") == ENCRYPTED_BACKUP_FORMAT:
        return envelope
    return None


def decrypt_backup_content(private_key: bytes, envelope: dict) -> bytes:
    """Raises ValueError when the envelope is malformed or the key is wrong."""
    try:
        sealed = base64.b64decode(envelope.get("sealed_base64") or "")
    except (TypeError, ValueError) as exc:
        raise ValueError("The backup envelope is malformed") from exc
    if not sealed:
        raise ValueError("The backup envelope is malformed")
    return backup_crypto.unseal(private_key, sealed)


# ---- pushing to the provider ---------------------------------------------------


async def push_frame_backup(
    link: CloudBackendLink,
    access_token: str,
    private_key: bytes,
    frame_dict: dict,
    project_name: str | None = None,
) -> tuple[int, dict]:
    payload = frame_backup_payload(frame_dict, project_name)
    content = encrypted_backup_content(
        private_key, json.dumps(payload).encode(), frame_backup_manifest(frame_dict, project_name)
    )
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
    link: CloudBackendLink,
    access_token: str,
    private_key: bytes,
    template_id: str,
    template_name: str | None,
    zip_bytes: bytes,
) -> tuple[int, dict]:
    content = encrypted_backup_content(private_key, zip_bytes, {"name": template_name or "Template"})
    return await cloud.backup_save(
        link.provider_url,
        access_token,
        {
            "kind": "templates",
            "item_key": f"template-{template_id}",
            "name": template_name or "Template",
            "content_base64": base64.b64encode(content).decode(),
            "content_type": "application/json",
        },
    )
