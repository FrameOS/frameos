"""The scene store on a frame (docs/scene-store.md, the Scene store scene):
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
THIRD = "0b1e8a52-6f0e-4a33-9f39-7a0d0b0b0a03"
NAMES = {RADAR: "Rain radar", OTHER: "Terminal", THIRD: "Split"}


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
        if parts[3:5] == ["device", "scenes"]:
            # The listing for frames: a scene's name and newest version.
            listed = parts[5] if len(parts) > 5 else ""
            if listed not in served:
                return httpx.Response(404, json={"error": "scene_not_found"})
            version = int(served[listed][0]["origin"]["version"])
            return httpx.Response(200, json={"id": listed, "name": NAMES.get(listed, "Scene"), "version": version})
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
async def test_install_without_show_stays_on_the_scene_showing(async_client, no_auth_client, db, store, monkeypatch):
    frame = await panel_frame(async_client, db)
    store[RADAR] = store_scene(RADAR, 1)

    async def showing(redis, frame):
        return "clock-1"

    monkeypatch.setattr(panel_scenes, "_active_scene", showing)
    response = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR, "show": False})
    assert response.status_code == 200, response.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt"]
    # Saved and sent, and the frame stays on the store (here, the clock).
    switch = commands(db, frame, "set_current_scene")
    assert switch and switch[-1].payload["scene_id"] == "clock-1"
    # Already there: nothing to do when it was asked to stay.
    again = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR, "show": False})
    assert again.json() == {"ok": True, "status": "up_to_date", "already_assigned": True}


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


@pytest.mark.asyncio
async def test_a_scene_of_the_same_id_is_replaced_keeping_its_values(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    # An older copy, from before the store stamped its origin.
    frame.scenes = [*frame.scenes, {"id": "radar-rt", "name": "My radar", "nodes": [], "edges": [],
                                    "fields": [{"name": "city", "type": "string", "value": "Ghent"}]}]
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 3)
    # A preview would push two scenes of one id.
    preview = await ask(no_auth_client, frame, {"action": "preview", "scene_id": RADAR})
    assert preview.status_code == 409
    response = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert response.status_code == 200, response.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt"]
    radar = frame.scenes[1]
    assert radar["name"] == "My radar" and radar["fields"][0]["value"] == "Ghent"
    assert radar["origin"]["storeSceneId"] == RADAR and radar["origin"]["version"] == "3"


@pytest.mark.asyncio
async def test_a_layout_is_tried_in_place_and_kept_around_every_scene(
    async_client, no_auth_client, db, store, monkeypatch
):
    frame = await panel_frame(async_client, db)
    layout = store_scene(RADAR, 1, ids=("bar-rt",))
    layout[0]["settings"]["isLayout"] = True
    store[RADAR] = layout

    async def showing(redis, frame):
        return "clock-1"

    monkeypatch.setattr(panel_scenes, "_active_scene", showing)
    # Tried: beside the list as a preview, and nothing switches (the store wears it).
    tried = await ask(no_auth_client, frame, {"action": "preview", "scene_id": RADAR, "show": False})
    assert tried.status_code == 200, tried.text
    assert tried.json()["scene_id"] == "bar-rt"
    pushed = commands(db, frame, "set_scenes")[-1].payload["_preview"]
    assert [scene["id"] for scene in pushed["scenes"]] == ["clock-1", "bar-rt"]
    assert commands(db, frame, "set_current_scene") == []

    # Kept: installed, every scene wears it, and the frame stays where it is.
    kept = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR, "show": True})
    assert kept.status_code == 200, kept.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "bar-rt"]
    assert frame.scenes[0]["layout"] == {"sceneId": "bar-rt", "state": {}}
    assert "layout" not in frame.scenes[1]
    assert commands(db, frame, "set_current_scene")[-1].payload["scene_id"] == "clock-1"


def asking_for(scenes: list[dict], permissions: list[str]) -> list[dict]:
    """The scenes with a JS app whose config.json asks for `permissions`."""
    config = json.dumps({"name": "t", "permissions": permissions})
    for scene in scenes:
        scene["apps"] = {"t": {"sources": {"config.json": config, "app.ts": "export function get() {}"}}}
    return scenes


@pytest.mark.asyncio
async def test_updates_lists_what_is_newer_and_what_asks_for_more(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    frame.scenes = [
        *frame.scenes,
        *store_scene(RADAR, 1),
        *asking_for(store_scene(OTHER, 2, ids=("term-rt",)), []),
        *store_scene(THIRD, 1, ids=("gone-rt",)),
    ]
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 3)
    # A version that starts asking for the frame's settings.
    store[OTHER] = asking_for(store_scene(OTHER, 4, ids=("term-rt",)), ["frame"])
    # THIRD: the store offers it no more.

    response = await ask(no_auth_client, frame, {"action": "updates"})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": True,
        "updates": [
            {"store": RADAR, "name": "Rain radar", "from": 1, "to": 3},
            {"store": OTHER, "name": "Terminal", "from": 2, "to": 4, "owner": True},
        ],
    }
    # A read changes nothing.
    db.refresh(frame)
    assert [scene["origin"]["version"] for scene in frame.scenes[1:]] == ["1", "2", "1"]
    assert commands(db, frame, "set_current_scene") == []

    # The one that asks for more is the owner's to update.
    widened = await ask(no_auth_client, frame, {"action": "update", "scene_id": OTHER})
    assert widened.status_code == 403
    assert widened.json() == {"ok": False, "error": "needs_owner", "needs": ["frame"]}


@pytest.mark.asyncio
async def test_updates_read_the_workspace_stamp_too(async_client, no_auth_client, db, store):
    """A store scene installed from the workspace's templates carries the
    longer stamp (frontend utils/sceneOrigin.ts sceneOriginForTemplate): the
    repository and template between the id and the version."""
    frame = await panel_frame(async_client, db)
    installed = store_scene(RADAR, 2)
    installed[0]["origin"] = {
        "href": "https://scenes.example/s/rain-radar",
        "storeSceneId": RADAR,
        "repositoryId": "store",
        "repositoryUrl": "https://cloud.example/api/store/repository.json",
        "templateId": "rain-radar",
        "templateName": "Rain radar",
        "sceneId": "radar-rt",
        "version": "2",
    }
    frame.scenes = [*frame.scenes, *installed]
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 2)

    current = await ask(no_auth_client, frame, {"action": "updates"})
    assert current.json() == {"ok": True, "updates": []}
    assert (await ask(no_auth_client, frame, {"action": "update", "scene_id": RADAR})).json() == {
        "ok": True,
        "status": "up_to_date",
        "version": "2",
    }

    store[RADAR] = store_scene(RADAR, 3)
    newer = await ask(no_auth_client, frame, {"action": "updates"})
    assert newer.json() == {"ok": True, "updates": [{"store": RADAR, "name": "Rain radar", "from": 2, "to": 3}]}


@pytest.mark.asyncio
async def test_an_install_that_replaces_a_scene_asks_for_nothing_more(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    # An older copy of the store's scene, from before the store stamped its
    # origin: what an install of the store's version replaces.
    frame.scenes = [*frame.scenes, {"id": "radar-rt", "name": "My radar", "nodes": [], "edges": []}]
    db.add(frame)
    db.commit()
    store[RADAR] = asking_for(store_scene(RADAR, 2), ["frame"])

    # The store's version asks for the frame's settings, the copy did not:
    # the owner's, as an update that asks for more is.
    widened = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert widened.status_code == 403
    assert widened.json() == {"ok": False, "error": "needs_owner", "needs": ["frame"]}
    db.refresh(frame)
    assert frame.scenes[1] == {"id": "radar-rt", "name": "My radar", "nodes": [], "edges": []}
    assert commands(db, frame, "set_current_scene") == []

    # A copy that asked for it already is replaced.
    frame.scenes = [frame.scenes[0], asking_for([{**frame.scenes[1]}], ["frame"])[0]]
    db.add(frame)
    db.commit()
    replaced = await ask(no_auth_client, frame, {"action": "install", "scene_id": RADAR})
    assert replaced.status_code == 200, replaced.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt"]
    assert frame.scenes[1]["name"] == "My radar" and frame.scenes[1]["origin"]["version"] == "2"

    # A scene the frame does not hold installs with what it asks for, as before.
    store[OTHER] = asking_for(store_scene(OTHER, 1, ids=("term-rt",)), ["frame"])
    fresh = await ask(no_auth_client, frame, {"action": "install", "scene_id": OTHER})
    assert fresh.status_code == 200, fresh.text
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt", "term-rt"]


@pytest.mark.asyncio
async def test_update_all_moves_every_scene_it_may_in_one_push(async_client, no_auth_client, db, store, monkeypatch):
    frame = await panel_frame(async_client, db)
    radar = store_scene(RADAR, 1)
    radar[0]["fields"][0]["value"] = "Ghent"
    radar[0]["eventMap"] = [{"on": "button"}]
    radar[0]["layout"] = {"sceneId": "bar-rt", "state": {}}
    split = store_scene(THIRD, 1, ids=("split-rt", "left-rt"))
    frame.scenes = [*frame.scenes, *radar, *store_scene(OTHER, 1, ids=("term-rt",)), *split]
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 2)
    store[OTHER] = asking_for(store_scene(OTHER, 2, ids=("term-rt",)), ["code"])
    store[THIRD] = store_scene(THIRD, 5, ids=("split-rt", "left-rt"))

    async def showing(redis, frame):
        return "clock-1"

    monkeypatch.setattr(panel_scenes, "_active_scene", showing)
    response = await ask(no_auth_client, frame, {"action": "updateAll"})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "status": "queued", "updated": 2, "kept": 1}
    db.refresh(frame)
    assert [scene["id"] for scene in frame.scenes] == ["clock-1", "radar-rt", "term-rt", "split-rt", "left-rt"]
    assert [scene["origin"]["version"] for scene in frame.scenes[1:]] == ["2", "1", "5", "5"]
    # The install's own: its values, button map and layout.
    assert frame.scenes[1]["fields"][0]["value"] == "Ghent"
    assert frame.scenes[1]["eventMap"] == [{"on": "button"}]
    assert frame.scenes[1]["layout"] == {"sceneId": "bar-rt", "state": {}}
    # One push, staying on the scene showing.
    switches = commands(db, frame, "set_current_scene")
    assert len(switches) == 1 and switches[0].payload["scene_id"] == "clock-1"

    again = await ask(no_auth_client, frame, {"action": "updateAll"})
    assert again.json() == {"ok": True, "status": "up_to_date", "updated": 0, "kept": 1}
    assert len(commands(db, frame, "set_current_scene")) == 1


@pytest.mark.asyncio
async def test_updates_are_refused_while_the_screen_settings_are_off(async_client, no_auth_client, db, store):
    frame = await panel_frame(async_client, db)
    frame.scenes = [*frame.scenes, *store_scene(RADAR, 1)]
    frame.frame_settings_on_screen = False
    db.add(frame)
    db.commit()
    store[RADAR] = store_scene(RADAR, 2)
    for action in ("updates", "updateAll"):
        locked = await ask(no_auth_client, frame, {"action": action})
        assert locked.status_code == 403
        assert locked.json()["error"] == "panel_locked"
    db.refresh(frame)
    assert frame.scenes[1]["origin"]["version"] == "1"
