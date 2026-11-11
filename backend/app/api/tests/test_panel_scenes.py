"""The scene store on a frame's own screen (docs/scene-store-on-frame.md):
POST /api/frames/{id}/panel/scenes with the frame's server_api_key installs,
updates, removes and previews public store scenes in the frame's saved list
and sends them the way "Install & activate" does. The store is a stub."""

import json

import httpx
import pytest

from app.api import panel_scenes
from app.api.tests.test_embedded_device import auth, device_frame
from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.utils import embedded_commands

RADAR = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a01"
OTHER = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a02"


def store_scene(store_id: str, version: int, ids=("radar-rt",), value_default="Brussels") -> list[dict]:
    return [
        {
            "id": scene_id,
            "name": f"Radar {scene_id}",
            "nodes": [{"id": "n1", "type": "app", "data": {"keyword": "x", "version": version}}],
            "edges": [],
            "fields": [{"name": "city", "type": "string", "value": value_default}],
            "settings": {"execution": "interpreted"},
            "origin": {"storeSceneId": store_id, "version": str(version), "sceneId": scene_id},
        }
        for scene_id in ids
    ]


@pytest.fixture
def store(monkeypatch):
    """The provider's scenes.json route: what each store scene serves now."""
    served: dict[str, list[dict]] = {}
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        parts = request.url.path.split("/")
        scene_id = parts[4] if len(parts) > 4 else ""
        if scene_id not in served:
            return httpx.Response(404, json={"error": "scene_not_found"})
        return httpx.Response(200, content=json.dumps(served[scene_id]).encode())

    def client(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(panel_scenes.httpx, "AsyncClient", client)
    monkeypatch.setattr(panel_scenes, "store_provider_url", lambda db: "https://cloud.example")
    return served


@pytest.fixture(autouse=True)
def no_nudge(monkeypatch):
    async def never(frame, redis):
        return False

    monkeypatch.setattr(embedded_commands, "nudge_embedded_frame", never)


async def panel_frame(async_client, db) -> Frame:
    frame = await device_frame(async_client, db)
    frame.scenes = [{"id": "clock-1", "name": "Clock", "default": True, "nodes": [], "edges": []}]
    db.add(frame)
    db.commit()
    return frame


def commands(db, frame, kind):
    return (
        db.query(FrameCommand)
        .filter(FrameCommand.frame_id == frame.id, FrameCommand.type == kind)
        .order_by(FrameCommand.created_at.asc())
        .all()
    )


async def ask(client, frame, body, headers=None):
    return await client.post(
        f"/api/frames/{frame.id}/panel/scenes", json=body, headers=auth(frame) if headers is None else headers
    )


@pytest.mark.asyncio
async def test_install_adds_the_store_scene_and_shows_it(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    store[RADAR] = store_scene(RADAR, 1)
    response = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "status": "queued", "version": "1"}
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt"]
    # Not the frame's default: that stays the owner's.
    assert "default" not in frame.scenes[1]
    switch = commands(db, frame, "set_current_scene")
    assert switch and switch[-1].payload["scene_id"] == "radar-rt"

    # Again: already there, shown, nothing added.
    again = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert again.json()["already_assigned"] is True
    db.refresh(frame)
    assert len(frame.scenes) == 2


@pytest.mark.asyncio
async def test_update_keeps_the_frame_copy_and_its_values(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    installed = store_scene(RADAR, 1)
    installed[0]["fields"][0]["value"] = "Ghent"
    installed[0]["eventMap"] = [{"on": "button"}]
    frame.scenes = [*frame.scenes, *installed]
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 2)

    response = await ask(no_auth_client, frame, {"action": "update", "scene_id": RADAR})
    assert response.json() == {"ok": True, "status": "queued", "version": "2"}
    db.refresh(frame)
    radar = frame.scenes[1]
    assert radar["origin"]["version"] == "2"
    assert radar["nodes"][0]["data"]["version"] == 2
    assert radar["fields"][0]["value"] == "Ghent"
    assert radar["eventMap"] == [{"on": "button"}]

    again = await ask(no_auth_client, frame, {"action": "update", "scene_id": RADAR})
    assert again.json() == {"ok": True, "status": "up_to_date", "version": "2"}


def test_update_maps_a_copy_installed_under_other_ids():
    saved = [
        {"id": "a-copy", "name": "Split", "nodes": [], "origin": {"storeSceneId": RADAR, "sceneId": "split", "version": "1"}},
        {"id": "b-copy", "name": "Left", "nodes": [], "origin": {"storeSceneId": RADAR, "sceneId": "left", "version": "1"}},
    ]
    new = store_scene(RADAR, 2, ids=("split", "left"))
    new[0]["nodes"] = [{"id": "s", "type": "scene", "data": {"keyword": "left"}}]
    updated = panel_scenes.updated_scenes(saved, RADAR, new)
    assert [scene["id"] for scene in updated] == ["a-copy", "b-copy"]
    assert updated[0]["nodes"][0]["data"]["keyword"] == "b-copy"


@pytest.mark.asyncio
async def test_remove_drops_the_store_scene_and_keeps_the_last(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    frame.scenes = [*frame.scenes, *store_scene(RADAR, 1)]
    db.add(frame)
    db.commit()
    response = await ask(no_auth_client, frame, {"action": "remove", "scene_id": RADAR})
    assert response.json() == {"ok": True, "status": "queued"}
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1"]
    assert (await ask(no_auth_client, frame, {"action": "remove", "scene_id": RADAR})).status_code == 404

    only = [{"id": "radar-rt", "origin": {"storeSceneId": OTHER}}]
    frame.scenes = only
    db.add(frame)
    db.commit()
    last = await ask(no_auth_client, frame, {"action": "remove", "scene_id": OTHER})
    assert last.status_code == 409
    assert last.json()["error"] == "last_scene"


@pytest.mark.asyncio
async def test_preview_comes_beside_the_saved_list_and_discard_goes_back(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    store[RADAR] = store_scene(RADAR, 1, ids=("split-rt", "left-rt"))
    response = await ask(no_auth_client, frame, {"action": "preview", "scene_id": RADAR})
    assert response.status_code == 200, response.text
    assert response.json()["scene_id"] == "split-rt"
    db.refresh(frame)
    # A preview is not an install.
    assert [scene["id"] for scene in frame.scenes] == ["clock-1"]
    pushed = commands(db, frame, "set_scenes")[-1].payload["_preview"]
    assert [scene["id"] for scene in pushed["scenes"]] == ["clock-1", "split-rt", "left-rt"]
    assert pushed["source"] == "panel"
    assert pushed["scene_id"] == "split-rt"

    discarded = await ask(no_auth_client, frame, {"action": "discard", "scene_id": "clock-1"})
    assert discarded.json() == {"ok": True, "status": "queued"}
    pushed = commands(db, frame, "set_scenes")[0].payload["_preview"]
    assert pushed.get("discarded") is True
    assert commands(db, frame, "set_current_scene")[-1].payload["scene_id"] == "clock-1"


@pytest.mark.asyncio
async def test_refuses_what_a_frame_may_not_ask(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    store[RADAR] = store_scene(RADAR, 1)
    assert (await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR}, headers={})).status_code == 401
    assert (
        await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR}, headers={"Authorization": "Bearer nope"})
    ).status_code == 401
    assert (await ask(no_auth_client, frame, {"action": "publish", "scene_id": RADAR})).status_code == 400
    assert (await ask(no_auth_client, frame, {"action": "install", "scene_id": "../x"})).status_code == 400
    missing = await ask(no_auth_client, frame, {"action": "install", "scene_id": OTHER})
    assert missing.status_code == 404

    # A store that answers something other than this scene is not installed.
    store[OTHER] = store_scene(RADAR, 1)
    forged = await ask(no_auth_client, frame, {"action": "install", "scene_id": OTHER})
    assert forged.status_code == 502

    frame.frame_settings_on_screen = False
    db.add(frame)
    db.commit()
    locked = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert locked.status_code == 403
    assert locked.json()["error"] == "panel_locked"
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1"]


@pytest.mark.asyncio
async def test_a_pi_asks_without_its_id(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    store[RADAR] = store_scene(RADAR, 1)
    response = await no_auth_client.post("/api/panel/scenes", json={"action": "install", "scene_id": RADAR}, headers=auth(frame))
    assert response.status_code == 200, response.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt"]
    wrong = await no_auth_client.post("/api/panel/scenes", json={"action": "install", "scene_id": RADAR})
    assert wrong.status_code == 401
