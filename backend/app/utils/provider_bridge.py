"""The backend's client for the provider sidecar's bridge.

The sidecar (cloud/apps/backend-provider) is FrameOS Cloud's frame hub,
unmodified, running next to the backend on its own Postgres with the cloud's
schema; its bridge (src/bridge.ts) is how the backend plays the part
auth-web plays on the cloud: register an enrolled frame's link token and
device key, queue a verb through the cloud's own enqueueFrameCommand (and
contract walker), read back a command's state, the frame's asset listing and
the files it sent. Bound to 127.0.0.1 in the container and gated by
FRAMEOS_PROVIDER_BRIDGE_SECRET.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from app.config import config

TIMEOUT = httpx.Timeout(connect=3.0, read=30.0, write=30.0, pool=3.0)


class BridgeError(Exception):
    """The bridge refused (its `error`), or is not there at all."""

    def __init__(self, error: str, status: int = 0):
        super().__init__(error)
        self.error = error
        self.status = status


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.FRAMEOS_PROVIDER_BRIDGE_URL,
        headers={"Authorization": f"Bearer {config.FRAMEOS_PROVIDER_BRIDGE_SECRET}"},
        timeout=TIMEOUT,
    )


async def _request(method: str, path: str, *, json: Any = None, params: Optional[dict] = None) -> httpx.Response:
    try:
        async with _client() as client:
            response = await client.request(method, path, json=json, params=params)
    except httpx.HTTPError as exc:
        raise BridgeError("sidecar_unavailable") from exc
    if response.status_code >= 400:
        try:
            error = response.json().get("error") or f"http_{response.status_code}"
        except ValueError:
            error = f"http_{response.status_code}"
        raise BridgeError(str(error), response.status_code)
    return response


async def register_frame(backend_frame_id: int, body: dict[str, Any]) -> str:
    """Create or re-key the sidecar's copy of an enrolled frame; its id there."""
    response = await _request("PUT", f"/internal/frames/by-backend/{int(backend_frame_id)}", json=body)
    return str(response.json()["frame_id"])


async def delete_frame(remote_frame_id: str) -> None:
    await _request("DELETE", f"/internal/frames/{remote_frame_id}")


async def frame_summary(remote_frame_id: str) -> dict[str, Any]:
    response = await _request("GET", f"/internal/frames/{remote_frame_id}")
    return response.json()["frame"]


async def enqueue_command(
    remote_frame_id: str,
    command_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    ttl_seconds: Optional[int] = None,
    supersede: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {"type": command_type, "supersede": supersede}
    if payload:
        body["payload"] = payload
    if ttl_seconds:
        body["ttl_ms"] = int(ttl_seconds) * 1000
    response = await _request("POST", f"/internal/frames/{remote_frame_id}/commands", json=body)
    return response.json()


async def command_status(remote_frame_id: str, command_id: str) -> dict[str, Any]:
    response = await _request("GET", f"/internal/frames/{remote_frame_id}/commands/{command_id}")
    return response.json()


async def pending_commands(remote_frame_id: str) -> list[dict[str, Any]]:
    response = await _request("GET", f"/internal/frames/{remote_frame_id}/commands")
    return list(response.json().get("commands") or [])


async def cancel_command(remote_frame_id: str, command_id: str) -> bool:
    try:
        await _request("DELETE", f"/internal/frames/{remote_frame_id}/commands/{command_id}")
    except BridgeError as exc:
        if exc.status == 404:
            return False
        raise
    return True


async def asset_listing(remote_frame_id: str) -> Optional[dict[str, Any]]:
    try:
        response = await _request("GET", f"/internal/frames/{remote_frame_id}/assets")
    except BridgeError as exc:
        if exc.status == 404:
            return None
        raise
    return response.json()


async def asset_file(remote_frame_id: str, path: str, *, thumb: bool = False) -> Optional[tuple[bytes, str, str]]:
    """(bytes, content type, updated_at ISO) of the file the frame last sent
    for `path`, or None when it never sent one."""
    try:
        response = await _request(
            "GET", f"/internal/frames/{remote_frame_id}/asset-file", params={"path": path, "thumb": "1" if thumb else "0"}
        )
    except BridgeError as exc:
        if exc.status == 404:
            return None
        raise
    return response.content, response.headers.get("content-type", ""), response.headers.get("x-updated-at", "")


async def device_scenes(remote_frame_id: str) -> Optional[dict[str, Any]]:
    try:
        response = await _request("GET", f"/internal/frames/{remote_frame_id}/device-scenes")
    except BridgeError as exc:
        if exc.status == 404:
            return None
        raise
    return response.json()


async def device_scenes_imported(remote_frame_id: str) -> None:
    await _request("POST", f"/internal/frames/{remote_frame_id}/device-scenes/imported")


async def browser_session() -> dict[str, Any]:
    response = await _request("POST", "/internal/session")
    return response.json()
