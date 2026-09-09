"""Every websocket broadcast that carries a frame is secret-free.

The project-wide socket reaches every browser signed into the backend, so a
frame's SSH password, API keys, agent secret, proxy key, admin password, mount
passwords and Wi-Fi passphrases must never ride on it. This pins the REAL
broadcast path (models.frame → websockets.publish_message → manager.broadcast)
rather than the helper alone, with a guard that walks the payload for both
the secret keys and the secret VALUES — a renamed key still leaks the value.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.models.frame import Frame, new_frame, update_frame
from app.utils.frame_secrets import (
    FINGERPRINTS_KEY,
    NESTED_SECRET_PATHS,
    SETTINGS_FINGERPRINTS_KEY,
    TOP_LEVEL_SECRET_KEYS,
)
from app import websockets

SECRET_LEAF_KEYS = frozenset(TOP_LEVEL_SECRET_KEYS) | frozenset(path[-1] for path in NESTED_SECRET_PATHS)
# Keyed HMAC fingerprints of the secrets, named after them, so the browser can
# tell a rotated secret from an unchanged one without seeing either. They are
# secret-free by construction; the value check below still runs over them.
FINGERPRINT_CONTAINERS = frozenset({FINGERPRINTS_KEY, SETTINGS_FINGERPRINTS_KEY})

SECRETS = {
    "ssh_pass": "ssh-password-9f1",
    "server_api_key": "server-api-key-3ab",
    "frame_access_key": "frame-access-key-77c",
    "agentSharedSecret": "agent-shared-secret-e02",
    "server_key": "-----BEGIN PRIVATE KEY-----proxy-key-51d",
    "pass": "admin-password-8d4",
    "password": "mount-password-2c9",
    "wifiPassword": "wifi-passphrase-b61",
    "wifiHotspotPassword": "hotspot-passphrase-a40",
}


def _walk(value: Any, path: str = ""):
    if isinstance(value, dict):
        for key, item in value.items():
            yield f"{path}.{key}" if path else str(key), key, item
            if key in FINGERPRINT_CONTAINERS:
                continue
            yield from _walk(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _walk(item, f"{path}[{index}]")


def assert_secret_free(payload: Any, secret_values: dict[str, str]) -> None:
    """Fail on any secret key holding a value, and on any secret value found
    anywhere — in a string leaf or embedded in a longer string."""
    for dotted, key, item in _walk(payload):
        if key in SECRET_LEAF_KEYS and item not in (None, "", [], {}):
            raise AssertionError(f"secret key {dotted!r} is set in a broadcast payload")
    serialized = json.dumps(payload)
    for name, value in secret_values.items():
        if value in serialized:
            raise AssertionError(f"secret value for {name!r} is present in a broadcast payload")


def _set_secrets(frame: Frame) -> None:
    frame.ssh_pass = SECRETS["ssh_pass"]
    frame.server_api_key = SECRETS["server_api_key"]
    frame.frame_access_key = SECRETS["frame_access_key"]
    frame.agent = {"agentEnabled": True, "agentSharedSecret": SECRETS["agentSharedSecret"]}
    frame.https_proxy = {
        "enable": True,
        "certs": {"server_cert": "cert", "server_key": SECRETS["server_key"]},
    }
    frame.frame_admin_auth = {"enabled": True, "user": "owner", "pass": SECRETS["pass"]}
    frame.mountpoints = {
        "items": [{"enabled": True, "source": "//nas/share", "target": "/mnt/share",
                   "username": "nas", "password": SECRETS["password"]}]
    }
    frame.network = {
        "wifiSSID": "home",
        "wifiPassword": SECRETS["wifiPassword"],
        "wifiHotspot": "enabled",
        "wifiHotspotPassword": SECRETS["wifiHotspotPassword"],
    }


@pytest.fixture
def broadcasts(monkeypatch):
    """The messages manager.broadcast() would have sent to every browser."""
    sent: list[dict[str, Any]] = []

    async def capture(message: str):
        sent.append(json.loads(message))

    monkeypatch.setattr(websockets.manager, "broadcast", capture)
    return sent


@pytest.mark.asyncio
async def test_new_frame_and_update_frame_broadcasts_carry_no_secret(db, redis, broadcasts):
    frame = await new_frame(db, redis, "SecretFrame", "pi:pi-password@frame.local", "backend.local")
    _set_secrets(frame)
    await update_frame(db, redis, frame)

    # The frame really does hold every secret (so the guard below has teeth).
    full = frame.to_dict()
    for name, value in SECRETS.items():
        assert value in json.dumps(full), f"{name} did not land on the frame"

    events = [message["event"] for message in broadcasts]
    assert "new_frame" in events and "update_frame" in events
    # Everything that went out over the socket — the frame events and the log
    # lines written alongside them — is guarded, not just the frame payloads.
    for message in broadcasts:
        assert_secret_free(message["data"], SECRETS)
        assert_secret_free(message["data"], {"initial ssh password": "pi-password"})
    frame_payloads = [message["data"] for message in broadcasts if message["event"] in ("new_frame", "update_frame")]
    assert all(payload["id"] == frame.id for payload in frame_payloads)


@pytest.mark.asyncio
async def test_secret_guard_catches_a_leak_through_a_renamed_key():
    with pytest.raises(AssertionError, match="secret value"):
        assert_secret_free({"id": 1, "extra": {"passphrase": SECRETS["wifiPassword"]}}, SECRETS)
    with pytest.raises(AssertionError, match="secret key"):
        assert_secret_free({"id": 1, "network": {"wifiPassword": "something-else"}}, SECRETS)
    assert_secret_free({"id": 1, "network": {"wifiPassword": ""}, "agent": {"agentEnabled": True}}, SECRETS)
