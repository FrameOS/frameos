"""A Linux frame this backend reaches only over its admin HTTP API.

An adopted generic Buildroot card ships no FrameOS Remote and takes no SSH
from here (`frame_has_shell_access()` is false). The backend is then the
frontend for the frame's own API — "remote lite": assets, fonts, service
keys, scene activation and scene snapshots all ride the admin session, and
the verbs that genuinely need a shell say so up front.
"""

from __future__ import annotations

import contextlib
import io
import json
import posixpath
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from app.api.tests.test_frames import (
    _adopt_request_body,
    _standalone_device_payload,
    _sync_admin_login_response,
)
from app.models.frame import Frame, frame_has_shell_access
from app.models.log import Log
from app.models.scene_image import SceneImage
from app.models.settings import Settings


def _png_bytes(size: tuple[int, int] = (40, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


class FakeCard:
    """A generic Buildroot card's admin API, as far as these tests drive it:
    files under /srv/assets, the config save, the settings save, the event
    route, the ping and the stored scene images."""

    def __init__(self, device_payload: dict, *, apply_runtime: str = "reload"):
        self.device_payload = device_payload
        self.apply_runtime = apply_runtime
        self.files: dict[str, bytes] = {}
        self.dirs: set[str] = set()
        self.parts: dict[str, bytearray] = {}
        self.posted: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self.scene_images: dict[str, bytes] = {}
        self.ping_failures_left = 0

    @staticmethod
    def _json(status: int, payload) -> tuple[int, bytes, dict]:
        return status, json.dumps(payload).encode(), {"content-type": "application/json"}

    async def fetch(self, frame_obj, redis_obj, *, path, method="GET", body=None, headers=None, timeout=None):
        parsed = urlparse(path)
        route, query = parsed.path, parse_qs(parsed.query)
        self.calls.append((method, path))
        if route == "/api/admin/login":
            return _sync_admin_login_response()
        if route == "/event/restart":
            self.posted.append({"__event__": "restart"})
            return self._json(200, {"status": "ok"})
        assert headers and "Cookie" in headers, f"{method} {path} without the admin session"
        if route == "/api/frames/1" and method == "GET":
            return self._json(200, {"frame": self.device_payload})
        if route == "/api/frames/1" and method == "POST":
            self.posted.append(json.loads(body))
            return self._json(200, {"message": "ok", "apply": {"runtime": self.apply_runtime}})
        if route == "/api/frames/1/ping":
            if self.ping_failures_left > 0:
                self.ping_failures_left -= 1
                raise ConnectionError("connection refused")
            return self._json(200, {"ok": True})
        if route == "/api/settings" and method == "POST":
            self.posted.append({"__settings__": json.loads(body)})
            return self._json(200, json.loads(body))
        if route == "/api/frames/1/event/setCurrentScene":
            self.posted.append({"__event__": "setCurrentScene", **json.loads(body)})
            return self._json(200, {"status": "ok"})
        if route.startswith("/api/frames/1/scene_images/"):
            scene_id = route.rsplit("/", 1)[1]
            if scene_id in self.scene_images:
                return 200, self.scene_images[scene_id], {"content-type": "image/png"}
            return self._json(404, {"detail": "Scene image not found"})
        if route == "/api/frames/1/assets" and method == "GET":
            entries = [{"path": f"/srv/assets/{d}", "size": 0, "mtime": 1, "is_dir": True} for d in sorted(self.dirs)]
            entries += [
                {"path": f"/srv/assets/{p}", "size": len(data), "mtime": 2, "is_dir": False}
                for p, data in sorted(self.files.items())
            ]
            return self._json(200, {"assets": entries})
        if route == "/api/frames/1/asset":
            rel = query["path"][0]
            if rel not in self.files:
                return self._json(404, {"detail": "Asset not found"})
            if query.get("thumb") == ["1"]:
                return 200, b"THUMB:" + rel.encode(), {"content-type": "image/png"}
            return 200, self.files[rel], {"content-type": "application/octet-stream"}
        if route == "/api/frames/1/assets/upload":
            assert headers.get("Content-Type") == "application/octet-stream"
            upload_id = query["upload_id"][0]
            index = int(query["chunk_index"][0])
            part = self.parts.setdefault(upload_id, bytearray())
            if index == 0:
                part.clear()
            part.extend(body)
            if query["complete"][0] != "1":
                return self._json(200, {"status": "partial"})
            rel = posixpath.join(query.get("path", [""])[0], query["filename"][0]).lstrip("/")
            self.files[rel] = bytes(part)
            del self.parts[upload_id]
            return self._json(200, {"path": f"/srv/assets/{rel}", "size": len(self.files[rel]), "mtime": 3, "is_dir": False})
        if route.startswith("/api/frames/1/assets/"):
            assert headers.get("Content-Type") == "application/x-www-form-urlencoded"
            form = {k: v[0] for k, v in parse_qs(body).items()}
            action = route.rsplit("/", 1)[1]
            if action == "mkdir":
                self.dirs.add(form["path"])
                return self._json(200, {"message": "Created"})
            if action == "delete":
                if form["path"] in self.files:
                    del self.files[form["path"]]
                    return self._json(200, {"message": "Deleted"})
                return self._json(404, {"detail": "Asset not found"})
            if action == "rename":
                self.files[form["dst"]] = self.files.pop(form["src"])
                return self._json(200, {"message": "Renamed"})
        raise AssertionError(f"unexpected device request: {method} {path}")


@contextlib.contextmanager
def _device(card: FakeCard):
    """Every place the backend fetches from a frame answers with the card."""
    mock = AsyncMock(side_effect=card.fetch)
    with patch("app.api.frames._fetch_frame_http_bytes", new=mock), patch(
        "app.utils.admin_api_assets._fetch_frame_http_bytes", new=mock
    ), patch("app.utils.frame_http._fetch_frame_http_bytes", new=mock):
        yield mock


def _card_payload(**overrides) -> dict:
    return {
        **_standalone_device_payload(),
        "mode": "buildroot",
        "buildroot": {"platform": "raspberry-pi-64"},
        "assets_path": "/srv/assets",
        **overrides,
    }


async def _adopt(async_client, db, card: FakeCard) -> Frame:
    with _device(card):
        response = await async_client.post("/api/frames/adopt", json=_adopt_request_body())
    assert response.status_code == 200, response.text
    db.expire_all()
    frame = db.get(Frame, response.json()["frame"]["id"])
    assert not frame_has_shell_access(frame)
    card.posted.clear()
    card.calls.clear()
    return frame


# ---------------------------------------------------------------------------
# Assets ride the admin API
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assets_panel_verbs_ride_the_admin_api(async_client, db, redis):
    card = FakeCard(_card_payload())
    card.files["photos/a.jpg"] = b"JPEGDATA"
    frame = await _adopt(async_client, db, card)

    with _device(card):
        listing = await async_client.get(f"/api/frames/{frame.id}/assets?refresh=1")
        assert listing.status_code == 200, listing.text
        assert [a["path"] for a in listing.json()["assets"]] == ["/srv/assets/photos/a.jpg"]
        assert listing.json()["storage"] is None

        made = await async_client.post(f"/api/frames/{frame.id}/assets/mkdir", data={"path": "fonts"})
        assert made.status_code == 200, made.text
        assert "fonts" in card.dirs

        uploaded = await async_client.post(
            f"/api/frames/{frame.id}/assets/upload",
            data={"path": "photos"},
            files={"file": ("b.png", b"PNGDATA", "image/png")},
        )
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["path"] == "photos/b.png"
        assert card.files["photos/b.png"] == b"PNGDATA"

        download = await async_client.get(
            f"/api/projects/{frame.project_id}/frames/{frame.id}/asset?path=photos/b.png&mode=image"
        )
        assert download.status_code == 200
        assert download.content == b"PNGDATA"

        # The runtime renders thumbnails itself: the backend never pulls the
        # original to resize it.
        thumb = await async_client.get(
            f"/api/projects/{frame.project_id}/frames/{frame.id}/asset?path=photos/b.png&thumb=1"
        )
        assert thumb.status_code == 200
        assert thumb.content == b"THUMB:photos/b.png"
        assert thumb.headers["content-type"].startswith("image/png")

        renamed = await async_client.post(
            f"/api/frames/{frame.id}/assets/rename", data={"src": "photos/b.png", "dst": "photos/c.png"}
        )
        assert renamed.status_code == 200, renamed.text
        assert "photos/c.png" in card.files and "photos/b.png" not in card.files

        deleted = await async_client.post(f"/api/frames/{frame.id}/assets/delete", data={"path": "photos/c.png"})
        assert deleted.status_code == 200, deleted.text
        assert "photos/c.png" not in card.files

        missing = await async_client.post(f"/api/frames/{frame.id}/assets/delete", data={"path": "photos/nope.png"})
        assert missing.status_code == 404

    # Every asset call went through the admin session, none over SSH.
    assert all(path.startswith("/api/") for _method, path in card.calls)
    # Paths on the wire are relative to the assets root — the device resolver
    # would otherwise nest /srv/assets under itself.
    assert not any("path=%2Fsrv" in path or "path=/srv" in path for _method, path in card.calls)


@pytest.mark.asyncio
async def test_large_uploads_are_chunked_under_the_runtime_body_cap(async_client, db, redis):
    from app.utils import admin_api_assets

    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    data = bytes(range(256)) * 40  # 10240 bytes

    with _device(card), patch.object(admin_api_assets, "ADMIN_API_UPLOAD_CHUNK_BYTES", 4096):
        payload = await admin_api_assets.upload_asset(frame, redis, "/srv/assets/big/blob.bin", data)
    assert payload["path"] == "/srv/assets/big/blob.bin"
    assert card.files["big/blob.bin"] == data
    uploads = [path for method, path in card.calls if method == "POST" and "/assets/upload" in path]
    assert len(uploads) == 3
    assert "complete=0" in uploads[0] and "complete=1" in uploads[-1]
    assert all("path=big&filename=blob.bin" in path for path in uploads)


@pytest.mark.asyncio
async def test_font_sync_uploads_over_the_admin_api(async_client, db, redis):
    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    db.add(Settings(project_id=frame.project_id, key="unused", value={}))
    db.commit()

    with _device(card):
        first = await async_client.post(f"/api/frames/{frame.id}/assets/sync")
        assert first.status_code == 200, first.text
        assert first.json()["uploaded"] > 0
        fonts = sorted(path for path in card.files if path.startswith("fonts/") and path.endswith(".ttf"))
        assert fonts, "the bundled faces reached the frame"
        # Same sizes on both ends: nothing to do the second time.
        second = await async_client.post(f"/api/frames/{frame.id}/assets/sync")
        assert second.status_code == 200, second.text
        assert second.json()["uploaded"] == 0


# ---------------------------------------------------------------------------
# The push carries what an SSH deploy would have written
# ---------------------------------------------------------------------------


def _scene_declaring(group: str, scene_id: str = "scene-keys") -> dict:
    return {
        "id": scene_id,
        "name": "Needs keys",
        "nodes": [
            {
                "id": "n1",
                "type": "app",
                "data": {
                    "keyword": "custom",
                    "sources": {"config.json": json.dumps({"settings": [group]})},
                },
            }
        ],
        "edges": [],
    }


@pytest.mark.asyncio
async def test_push_carries_service_keys_extra_keys_and_explicit_off_states(async_client, db, redis):
    from app.api.frame_sync import push_backend_state_to_device

    # A panel without buttons of its own, so an empty GPIO list stays empty
    # (the Inky default would fill four back in).
    card = FakeCard(_card_payload(device="framebuffer"))
    frame = await _adopt(async_client, db, card)
    db.add(Settings(project_id=frame.project_id, key="openAI", value={"apiKey": "sk-test"}))
    frame.scenes = [_scene_declaring("openAI")]
    # An earlier deploy shipped an Unsplash key the scenes no longer declare:
    # the field is blanked on the device rather than left behind.
    frame.last_successful_deploy = {**frame.last_successful_deploy, "settings_fingerprints": {"unsplash": "fp"}}
    frame.schedule = {"events": []}
    frame.gpio_buttons = []
    frame.reboot = {"enabled": False}
    frame.control_code = {"enabled": False}
    frame.frame_access = "public"
    frame.log_to_file = "/srv/frameos/logs/frame-{date}.log"
    frame.timezone_updater = {"enabled": True}
    db.commit()

    with _device(card):
        pushed = await push_backend_state_to_device(frame, db, redis, card.fetch)

    settings_posts = [entry["__settings__"] for entry in card.posted if "__settings__" in entry]
    assert settings_posts == [{"openAI": {"apiKey": "sk-test"}, "unsplash": {"accessKey": ""}}]
    # Settings land before the config save, whose reload re-reads frame.json.
    assert "__settings__" in card.posted[0]
    saved = next(entry for entry in card.posted if "name" in entry)
    assert saved["schedule"] == {"events": []} and saved["frame_access"] == "public"
    assert pushed["schedule"] == {"events": []}
    assert pushed["gpio_buttons"] == []
    assert pushed["reboot"] == {"enabled": False}
    assert pushed["control_code"] == {"enabled": False}
    assert pushed["frame_access"] == "public"
    assert pushed["frame_access_key"] == frame.frame_access_key
    assert pushed["server_api_key"] == frame.server_api_key
    assert pushed["log_to_file"] == "/srv/frameos/logs/frame-{date}.log"
    assert pushed["timezone_updater"]["enabled"] is True
    # Still never the keys that say how THIS backend reaches the frame.
    for key in ("ssh_pass", "ssh_keys", "frame_host", "frame_port", "agent", "mode"):
        assert key not in pushed
    logs = [log.line for log in db.query(Log).filter_by(frame_id=frame.id).all()]
    assert any("Service keys written to the frame: openAI, unsplash" in line for line in logs)


@pytest.mark.asyncio
async def test_push_skips_the_settings_route_when_nothing_is_shipped(async_client, db, redis):
    from app.api.frame_sync import push_backend_state_to_device

    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    with _device(card):
        await push_backend_state_to_device(frame, db, redis, card.fetch)
    assert not any("__settings__" in entry for entry in card.posted)


@pytest.mark.asyncio
async def test_push_activates_the_scene_after_the_reload(async_client, db, redis):
    from app.api.frame_sync import push_backend_state_to_device

    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    frame.scenes = [{"id": "scene-1", "name": "One", "nodes": [], "edges": []},
                    {"id": "scene-2", "name": "Two", "nodes": [], "edges": []}]
    db.commit()

    with _device(card):
        await push_backend_state_to_device(
            frame, db, redis, card.fetch, activate_scene={"sceneId": "scene-2", "state": {"greeting": "hi"}}
        )
    kinds = [entry.get("__event__") or ("save" if "scenes" in entry else "meta") for entry in card.posted]
    assert kinds == ["save", "setCurrentScene", "meta"]
    event = next(entry for entry in card.posted if entry.get("__event__") == "setCurrentScene")
    assert event["sceneId"] == "scene-2" and event["state"] == {"greeting": "hi"}


@pytest.mark.asyncio
async def test_push_waits_for_a_restarting_runtime_before_activating(async_client, db, redis):
    from app.api import frame_sync
    from app.api.frame_sync import push_backend_state_to_device

    card = FakeCard(_card_payload(), apply_runtime="restart")
    frame = await _adopt(async_client, db, card)
    card.ping_failures_left = 2

    with _device(card), patch.object(frame_sync, "RUNTIME_RETURN_POLL_SECONDS", 0.0):
        await push_backend_state_to_device(frame, db, redis, card.fetch, activate_scene={"sceneId": "scene-1"})
    pings = [path for _m, path in card.calls if path == "/api/frames/1/ping"]
    assert len(pings) == 3
    events = [entry for entry in card.posted if entry.get("__event__") == "setCurrentScene"]
    assert events and events[0]["sceneId"] == "scene-1" and "state" not in events[0]
    # The wait came after the save was acknowledged, before the activation.
    order = [path for _m, path in card.calls if path in ("/api/frames/1", "/api/frames/1/ping", "/api/frames/1/event/setCurrentScene")]
    assert order.index("/api/frames/1/ping") > order.index("/api/frames/1")
    assert order.index("/api/frames/1/event/setCurrentScene") > order.index("/api/frames/1/ping")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_next_scene_queues_the_push_with_the_scene_to_activate(async_client, db, redis):
    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    frame.scenes = [{"id": "scene-1", "name": "One", "nodes": [], "edges": []}]
    db.commit()

    with patch("app.tasks.fast_deploy_frame.enqueue_unique_job", new=AsyncMock()) as enqueue:
        response = await async_client.post(
            f"/api/frames/{frame.id}/set_next_scene",
            json={"sceneId": "scene-1", "state": {"x": 1}, "fastDeploy": False},
        )
    assert response.status_code == 200, response.text
    enqueue.assert_awaited_once()
    args, kwargs = enqueue.await_args
    assert args[1] == "fast_deploy_frame"
    assert kwargs["id"] == frame.id
    assert kwargs["activate_scene"] == {"sceneId": "scene-1", "state": {"x": 1}}


@pytest.mark.asyncio
async def test_shell_only_verbs_answer_400_up_front(async_client, db, redis):
    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)

    for verb in ("deploy_remote", "restart_remote", "stop", "clear_build_cache"):
        response = await async_client.post(f"/api/frames/{frame.id}/{verb}")
        assert response.status_code == 400, (verb, response.text)
        assert "admin API" in response.json()["detail"]
    keys = await async_client.post(f"/api/frames/{frame.id}/ssh_keys", json={"ssh_keys": []})
    assert keys.status_code == 400
    # Restart and reboot stay: they ride the runtime's own control verbs.
    restart = await async_client.post(f"/api/frames/{frame.id}/restart")
    assert restart.status_code == 200, restart.text


@pytest.mark.asyncio
async def test_full_deploy_task_delegates_to_the_admin_api_push(async_client, db, redis):
    from app.tasks.deploy_frame import deploy_frame_task

    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    with _device(card):
        await deploy_frame_task({"db": db, "redis": redis, "job_id": "job-1"}, frame.id, task_id="task-1")
    assert any("scenes" in entry for entry in card.posted)
    db.expire_all()
    logs = [log.line for log in db.query(Log).filter_by(frame_id=frame.id).all()]
    assert any("pushing scenes and settings over its admin API" in line for line in logs)
    assert any("task-1" in line and "completed" in line for line in logs)
    assert db.get(Frame, frame.id).status == "ready"


@pytest.mark.asyncio
async def test_scene_snapshot_is_pulled_from_the_frame_once(async_client, db, redis):
    card = FakeCard(_card_payload())
    frame = await _adopt(async_client, db, card)
    card.scene_images["scene-1"] = _png_bytes()

    with _device(card):
        first = await async_client.get(f"/api/projects/{frame.project_id}/frames/{frame.id}/scene_images/scene-1")
        assert first.status_code == 200
        assert first.content.startswith(b"\x89PNG")
        assert Image.open(io.BytesIO(first.content)).size == (40, 30)
        assert db.query(SceneImage).filter_by(frame_id=frame.id, scene_id="scene-1").count() == 1
        pulls = [path for _m, path in card.calls if "/scene_images/" in path]
        assert pulls == ["/api/frames/1/scene_images/scene-1"]

        # Stored now: the second request never asks the frame again.
        second = await async_client.get(
            f"/api/projects/{frame.project_id}/frames/{frame.id}/scene_images/scene-1?thumb=1"
        )
        assert second.status_code == 200
        assert second.headers["content-type"] == "image/jpeg"
        assert [path for _m, path in card.calls if "/scene_images/" in path] == pulls

        # A scene the frame has no picture of: placeholder, and the miss is
        # remembered so the fleet page does not ask on every tile render.
        for _ in range(2):
            missing = await async_client.get(
                f"/api/projects/{frame.project_id}/frames/{frame.id}/scene_images/scene-9"
            )
            assert missing.status_code == 200
        assert [path for _m, path in card.calls if "scene-9" in path] == ["/api/frames/1/scene_images/scene-9"]
