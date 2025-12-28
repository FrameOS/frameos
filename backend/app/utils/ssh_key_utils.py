from __future__ import annotations

from typing import Any


def normalize_ssh_keys(settings: dict[str, Any]) -> list[dict[str, Any]]:
    ssh_keys = settings.get("ssh_keys") or {}
    normalized: list[dict[str, Any]] = []

    if isinstance(ssh_keys, dict):
        raw_keys = ssh_keys.get("keys")
        if isinstance(raw_keys, list):
            for entry in raw_keys:
                if not isinstance(entry, dict):
                    continue
                key_id = str(entry.get("id") or "").strip()
                if not key_id:
                    continue
                normalized.append(
                    {
                        "id": key_id,
                        "name": entry.get("name") or key_id,
                        "private": entry.get("private") or "",
                        "public": entry.get("public") or "",
                        "use_for_new_frames": bool(entry.get("use_for_new_frames")),
                    }
                )

    if normalized:
        return normalized

    if isinstance(ssh_keys, dict):
        legacy_private = ssh_keys.get("default")
        legacy_public = ssh_keys.get("default_public")
        if legacy_private or legacy_public:
            return [
                {
                    "id": "default",
                    "name": "Default",
                    "private": legacy_private or "",
                    "public": legacy_public or "",
                    "use_for_new_frames": True,
                }
            ]

    return []


def ssh_key_map(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {key["id"]: key for key in normalize_ssh_keys(settings)}


def select_ssh_keys_for_frame(frame, settings: dict[str, Any]) -> list[dict[str, Any]]:
    keys = normalize_ssh_keys(settings)
    if getattr(frame, "ssh_keys", None):
        selected = [key for key in keys if key["id"] in (frame.ssh_keys or [])]
        if selected:
            return selected
    use_for_new = [key for key in keys if key.get("use_for_new_frames")]
    if use_for_new:
        return use_for_new
    return keys


def default_ssh_key_ids(settings: dict[str, Any]) -> list[str]:
    return [key["id"] for key in normalize_ssh_keys(settings) if key.get("use_for_new_frames")]
