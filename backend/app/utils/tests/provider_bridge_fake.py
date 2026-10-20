"""An in-memory provider sidecar bridge for tests (app/utils/provider_bridge.py).

The real one is cloud/apps/backend-provider/src/bridge.ts in front of the
cloud's frame hub; its own integration suite drives a fake device through it.
Here the backend's side of the conversation is what is under test, so the
bridge keeps the queue in a list and a test plays the device by setting a
command's status.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

import pytest

from app.utils import provider_bridge
from app.utils.provider_bridge import BridgeError


class FakeBridge:
    def __init__(self) -> None:
        self.frames: dict[int, dict[str, Any]] = {}
        self.commands: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.listings: dict[str, dict[str, Any]] = {}
        self.files: dict[tuple[str, str, bool], tuple[bytes, str, str]] = {}
        self.summaries: dict[str, dict[str, Any]] = {}
        self.device_scenes_documents: dict[str, dict[str, Any]] = {}
        self.imported: list[str] = []
        self.down = False

    def _check(self) -> None:
        if self.down:
            raise BridgeError("sidecar_unavailable")

    async def register_frame(self, backend_frame_id: int, body: dict[str, Any]) -> str:
        self._check()
        entry = self.frames.setdefault(int(backend_frame_id), {"remote_id": str(uuid4())})
        entry["body"] = body
        return entry["remote_id"]

    async def delete_frame(self, remote_frame_id: str) -> None:
        self._check()
        self.deleted.append(remote_frame_id)

    async def frame_summary(self, remote_frame_id: str) -> dict[str, Any]:
        self._check()
        return self.summaries.get(remote_frame_id, {"id": remote_frame_id})

    async def enqueue_command(
        self, remote_frame_id: str, command_type: str, payload: Optional[dict[str, Any]] = None,
        *, ttl_seconds: Optional[int] = None, supersede: bool = False,
    ) -> dict[str, Any]:
        self._check()
        if supersede:
            for command in self.commands:
                if command["frame"] == remote_frame_id and command["type"] == command_type and command["status"] in ("pending", "sent"):
                    command["status"] = "expired"
                    command["error"] = "superseded"
        command = {
            "id": str(uuid4()),
            "frame": remote_frame_id,
            "type": command_type,
            "payload": payload,
            "ttl_seconds": ttl_seconds,
            "status": "pending",
            "error": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": None,
            "sent_at": None,
        }
        self.commands.append(command)
        return dict(command)

    async def command_status(self, remote_frame_id: str, command_id: str) -> dict[str, Any]:
        self._check()
        for command in self.commands:
            if command["id"] == command_id and command["frame"] == remote_frame_id:
                return dict(command)
        raise BridgeError("command_not_found", 404)

    async def pending_commands(self, remote_frame_id: str) -> list[dict[str, Any]]:
        self._check()
        return [dict(c) for c in self.commands if c["frame"] == remote_frame_id and c["status"] in ("pending", "sent")]

    async def cancel_command(self, remote_frame_id: str, command_id: str) -> bool:
        for command in self.commands:
            if command["id"] == command_id and command["status"] in ("pending", "sent"):
                command["status"] = "expired"
                command["error"] = "cancelled"
                return True
        return False

    async def asset_listing(self, remote_frame_id: str) -> Optional[dict[str, Any]]:
        return self.listings.get(remote_frame_id)

    async def asset_file(self, remote_frame_id: str, path: str, *, thumb: bool = False) -> Optional[tuple[bytes, str, str]]:
        return self.files.get((remote_frame_id, path, thumb))

    async def device_scenes(self, remote_frame_id: str) -> Optional[dict[str, Any]]:
        return self.device_scenes_documents.get(remote_frame_id)

    async def device_scenes_imported(self, remote_frame_id: str) -> None:
        self.imported.append(remote_frame_id)

    async def browser_session(self) -> dict[str, Any]:
        return {"cookie": "frameos_cloud_session=test", "expires_at": datetime.now(timezone.utc).isoformat()}

    # ------------------------------------------------------------ the device

    def of_frame(self, remote_frame_id: str) -> list[dict[str, Any]]:
        return [c for c in self.commands if c["frame"] == remote_frame_id]

    def answer(self, command_id: str, *, ok: bool = True, error: Optional[str] = None) -> None:
        for command in self.commands:
            if command["id"] == command_id:
                command["status"] = "acked" if ok else "failed"
                command["error"] = None if ok else (error or "failed")


@pytest.fixture
def fake_bridge(monkeypatch) -> FakeBridge:
    fake = FakeBridge()
    for name in (
        "register_frame", "delete_frame", "frame_summary", "enqueue_command", "command_status",
        "pending_commands", "cancel_command", "asset_listing", "asset_file", "device_scenes",
        "device_scenes_imported", "browser_session",
    ):
        monkeypatch.setattr(provider_bridge, name, getattr(fake, name))
    return fake
