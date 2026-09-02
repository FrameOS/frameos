"""Secrets that live on a Frame row and must not ride along with every copy
of it.

``Frame.to_dict()`` is the wire shape for the authenticated API, but the same
dict is also broadcast on every ``update_frame`` websocket event and stored
verbatim as the ``last_successful_deploy`` baseline. Two helpers keep the
secrets out of those two places:

- ``websocket_frame_payload`` for the broadcast. The frontend merges each
  ``update_frame`` payload *shallowly* into its frame object
  (``{...state[id], ...frame}``), so a key that is present replaces the
  client's copy wholesale and a key that is absent leaves it untouched.
  Top-level secrets are therefore popped, and so are the whole objects that
  carry a nested secret (``https_proxy``, ``agent``, ``frame_admin_auth``,
  ``mountpoints``): sending them with the secret leaf removed would blank the
  client's copy of that leaf, which the settings form then saves back as
  empty. Popping the container keeps the client's last GET intact.

- ``deploy_snapshot`` / ``restore_snapshot_secrets`` for the stored baseline.
  The snapshot is a diff baseline ("what changed since the last deploy"), so
  it cannot simply lose the secrets: every consumer would read a missing key
  as a change. The stored copy keeps an HMAC fingerprint per secret instead,
  and ``restore_snapshot_secrets`` fills the *current* value back in wherever
  the fingerprint still matches — so an unchanged secret compares equal and a
  rotated one shows as changed, without the old value ever being kept.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
from typing import Any, Iterator

from app.config import config

# Top-level Frame.to_dict() keys that are secrets outright.
TOP_LEVEL_SECRET_KEYS = ("ssh_pass", "server_api_key", "frame_access_key")

# Secret leaves inside nested objects; "*" iterates a list.
NESTED_SECRET_PATHS = (
    ("https_proxy", "certs", "server_key"),
    ("agent", "agentSharedSecret"),
    ("frame_admin_auth", "pass"),
    ("mountpoints", "items", "*", "password"),
)

# The top-level objects a nested secret lives in. Popped whole from websocket
# payloads (see the module docstring for why).
SECRET_CONTAINER_KEYS = tuple(dict.fromkeys(path[0] for path in NESTED_SECRET_PATHS))

FINGERPRINTS_KEY = "secret_fingerprints"


def _walk(value: Any, path: tuple[str, ...], prefix: str = "") -> Iterator[tuple[Any, str, str]]:
    """Yield ``(container, key, dotted_path)`` for every leaf that ``path``
    addresses inside ``value``; skips whatever is missing or not a dict/list."""
    head, rest = path[0], path[1:]
    if head == "*":
        if not isinstance(value, list):
            return
        for index, item in enumerate(value):
            yield from _walk(item, rest, f"{prefix}{index}.")
        return
    if not isinstance(value, dict) or head not in value:
        return
    if not rest:
        yield value, head, f"{prefix}{head}"
        return
    yield from _walk(value[head], rest, f"{prefix}{head}.")


def _secret_paths() -> tuple[tuple[str, ...], ...]:
    return tuple((key,) for key in TOP_LEVEL_SECRET_KEYS) + NESTED_SECRET_PATHS


def _copy_touched(frame_dict: dict) -> dict:
    """A copy of ``frame_dict`` that shares nothing with the secret-bearing
    parts, so removing leaves cannot mutate the ORM's JSON columns."""
    result = dict(frame_dict)
    for key in SECRET_CONTAINER_KEYS:
        if key in result:
            result[key] = copy.deepcopy(result[key])
    return result


def redact_frame_secrets(frame_dict: dict) -> dict:
    """``frame_dict`` with every set secret leaf removed (containers kept;
    an empty value is not a secret and stays so shapes round-trip)."""
    result = _copy_touched(frame_dict)
    for path in _secret_paths():
        for container, key, _ in list(_walk(result, path)):
            if container.get(key) not in (None, ""):
                container.pop(key, None)
    return result


def websocket_frame_payload(frame_dict: dict) -> dict:
    """The ``update_frame`` broadcast shape: secrets and the objects that
    carry them are omitted, never sent empty (shallow client merge)."""
    payload = dict(frame_dict)
    for key in TOP_LEVEL_SECRET_KEYS + SECRET_CONTAINER_KEYS:
        payload.pop(key, None)
    # ``last_successful_deploy`` is left as ``to_dict()`` serialized it: the
    # frontend diffs it key by key against its own copy of the frame, so a
    # stripped baseline would report every secret as "changed since deploy"
    # after each deploy. What it carries is only what already matches the
    # current row (restore_snapshot_secrets), never a superseded value.
    return payload


def _fingerprint_keys() -> list[str]:
    return [key for key in (config.SECRET_KEY, *config.PREVIOUS_SECRET_KEYS) if key]


def _fingerprint(value: Any, key: str) -> str:
    return hmac.new(key.encode("utf-8"), str(value).encode("utf-8"), hashlib.sha256).hexdigest()


def frame_secret_fingerprints(frame_dict: dict) -> dict[str, str]:
    """``{dotted_path: hmac}`` for every non-empty secret in ``frame_dict``."""
    keys = _fingerprint_keys()
    if not keys:
        return {}
    fingerprints: dict[str, str] = {}
    for path in _secret_paths():
        for container, key, dotted in _walk(frame_dict, path):
            value = container.get(key)
            if value not in (None, ""):
                fingerprints[dotted] = _fingerprint(value, keys[0])
    return fingerprints


def deploy_snapshot(frame_dict: dict) -> dict:
    """What ``last_successful_deploy`` stores: the frame minus its secrets,
    plus their fingerprints so the baseline diff still works."""
    snapshot = redact_frame_secrets(frame_dict)
    snapshot.pop("last_successful_deploy", None)
    snapshot.pop("last_successful_deploy_at", None)
    fingerprints = frame_secret_fingerprints(frame_dict)
    if fingerprints:
        snapshot[FINGERPRINTS_KEY] = fingerprints
    return snapshot


def restore_snapshot_secrets(snapshot: Any, current: dict) -> Any:
    """The stored snapshot as consumers expect it: each secret whose
    fingerprint matches the value in ``current`` is filled back in from
    ``current``; the rest stay absent. Snapshots written before fingerprints
    existed are returned unchanged."""
    if not isinstance(snapshot, dict) or FINGERPRINTS_KEY not in snapshot:
        return snapshot
    fingerprints = snapshot.get(FINGERPRINTS_KEY) or {}
    result = _copy_touched(snapshot)
    result.pop(FINGERPRINTS_KEY, None)
    keys = _fingerprint_keys()
    for path in _secret_paths():
        for container, key, dotted in _walk(current, path):
            value = container.get(key)
            stored = fingerprints.get(dotted)
            if value in (None, "") or not stored:
                continue
            if not any(hmac.compare_digest(stored, _fingerprint(value, k)) for k in keys):
                continue
            target = result
            for part in dotted.split(".")[:-1]:
                if isinstance(target, list):
                    index = int(part)
                    target = target[index] if index < len(target) else None
                else:
                    target = target.get(part) if isinstance(target, dict) else None
                if target is None:
                    break
            if isinstance(target, dict):
                target[key] = value
    return result


def deployed_frame_snapshot(frame: Any) -> Any:
    """``frame.last_successful_deploy`` with matching secrets restored from
    the frame's current columns. Works on ORM rows and on the SimpleNamespace
    stand-ins the deploy tests use."""
    snapshot = getattr(frame, "last_successful_deploy", None)
    if not isinstance(snapshot, dict):
        return snapshot
    current = {
        key: getattr(frame, key, None)
        for key in TOP_LEVEL_SECRET_KEYS + SECRET_CONTAINER_KEYS
    }
    return restore_snapshot_secrets(snapshot, current)
