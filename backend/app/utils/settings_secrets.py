"""Project settings hold third-party credentials (OpenAI, Home Assistant,
Unsplash, ... keys, the build host's private SSH key, the default Wi-Fi
passphrase). `GET /api/settings` used to hand every one of them out in clear
to any logged-in session, on every settings-page load.

Same contract as the cloud's account settings (cloud/apps/auth-web/src/lib/
setting-mask.ts + account-settings.ts), which the shared SPA already speaks:

- GET answers a secret field as its MASK — eight bullets plus the last four
  characters when the value is long enough for those to identify it without
  helping anyone guess the rest. `?reveal=1` returns the real values; it
  exists for the in-browser wasm preview, which runs the scene and needs the
  bytes.
- A form posts the whole group back, mask included. A secret posted as a
  mask means "keep what is stored"; a mask is never a value.

The settings *readers* on the server (`get_settings_dict`) are untouched —
only the HTTP GET view is masked and only the HTTP POST resolves masks."""
from __future__ import annotations

import copy
from typing import Any

MASK_BULLETS = "••••••••"

# Secret leaves by group, mirroring the `secret` markers on the settings form
# (frontend/src/scenes/settings/Settings.tsx) and secretSettings.ts.
SECRET_SETTING_FIELDS: dict[str, frozenset[str]] = {
    "defaults": frozenset({"wifiPassword"}),
    "homeAssistant": frozenset({"accessToken", "mqttPassword"}),
    "frameOS": frozenset({"apiKey"}),
    "github": frozenset({"api_key"}),
    "immich": frozenset({"apiKey"}),
    "openAI": frozenset({"apiKey", "backendApiKey"}),
    "posthog": frozenset({"backendApiKey"}),
    "unsplash": frozenset({"accessKey"}),
    "buildHost": frozenset({"sshKey"}),
    "modalSandbox": frozenset({"tokenId", "tokenSecret"}),
}
# `ssh_keys.keys[*].private`: a list of entries keyed by `id`.
SSH_KEYS_GROUP = "ssh_keys"
SSH_KEY_SECRET_FIELD = "private"


def mask_setting_value(secret: str) -> str:
    if secret == "":
        return ""
    return f"{MASK_BULLETS}{secret[-4:]}" if len(secret) > 8 else MASK_BULLETS


def is_masked_setting_value(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(MASK_BULLETS)


def is_secret_setting_field(group: str, field: str) -> bool:
    return field in SECRET_SETTING_FIELDS.get(group, frozenset())


def _mask_ssh_keys(group: Any) -> Any:
    if not isinstance(group, dict) or not isinstance(group.get("keys"), list):
        return group
    masked = dict(group)
    masked["keys"] = [
        {**entry, SSH_KEY_SECRET_FIELD: mask_setting_value(entry[SSH_KEY_SECRET_FIELD])}
        if isinstance(entry, dict) and isinstance(entry.get(SSH_KEY_SECRET_FIELD), str)
        else entry
        for entry in group["keys"]
    ]
    return masked


def mask_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """The GET view: every secret leaf replaced by its mask. Non-string
    secret values (nothing stores those) pass through untouched."""
    masked = copy.deepcopy(settings)
    for group, fields in SECRET_SETTING_FIELDS.items():
        value = masked.get(group)
        if not isinstance(value, dict):
            continue
        for field in fields:
            if isinstance(value.get(field), str):
                value[field] = mask_setting_value(value[field])
    if SSH_KEYS_GROUP in masked:
        masked[SSH_KEYS_GROUP] = _mask_ssh_keys(masked[SSH_KEYS_GROUP])
    return masked


def _resolve_ssh_keys(posted: Any, stored: Any) -> Any:
    if not isinstance(posted, dict) or not isinstance(posted.get("keys"), list):
        return posted
    stored_by_id: dict[str, dict] = {}
    if isinstance(stored, dict) and isinstance(stored.get("keys"), list):
        for entry in stored["keys"]:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                stored_by_id[entry["id"]] = entry
    resolved = dict(posted)
    keys: list[Any] = []
    for entry in posted["keys"]:
        if isinstance(entry, dict) and is_masked_setting_value(entry.get(SSH_KEY_SECRET_FIELD)):
            current = stored_by_id.get(entry.get("id") or "", {}).get(SSH_KEY_SECRET_FIELD)
            entry = dict(entry)
            if isinstance(current, str) and current != "":
                entry[SSH_KEY_SECRET_FIELD] = current
            else:
                entry.pop(SSH_KEY_SECRET_FIELD, None)
        keys.append(entry)
    resolved["keys"] = keys
    return resolved


def resolve_masked_settings(payload: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    """The POST side: a secret posted as its own mask keeps the stored value
    (or is dropped when nothing is stored). Returns a new payload."""
    resolved = copy.deepcopy(payload)
    for group, fields in SECRET_SETTING_FIELDS.items():
        value = resolved.get(group)
        if not isinstance(value, dict):
            continue
        current_group = stored.get(group) if isinstance(stored.get(group), dict) else {}
        for field in fields:
            if not is_masked_setting_value(value.get(field)):
                continue
            current = current_group.get(field)
            if isinstance(current, str) and current != "":
                value[field] = current
            else:
                value.pop(field, None)
    if SSH_KEYS_GROUP in resolved:
        resolved[SSH_KEYS_GROUP] = _resolve_ssh_keys(resolved[SSH_KEYS_GROUP], stored.get(SSH_KEYS_GROUP))
    return resolved


def resolve_masked_secret(value: Any, stored: Any) -> Any:
    """One leaf: the stored value when `value` is a mask, else `value`.
    For places that receive a copy of a setting outside the settings form —
    a new frame's Wi-Fi passphrase prefilled from the project defaults."""
    if is_masked_setting_value(value):
        return stored if isinstance(stored, str) else ""
    return value
