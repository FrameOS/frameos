"""The code editor on a frame (docs/code-editor.md, the Code editor scene):
POST /api/frames/{id}/panel/code with the frame's server_api_key asks the
scene AI for a draft (nothing saved) and saves a scene into the frame's list,
never widening what the scene may do. The scene AI is a stub."""

import json

import pytest

from app.api import panel_code
from app.api.tests.test_embedded_device import auth, device_frame
from app.models.frame import Frame
from app.models.frame_command import FrameCommand
from app.models.settings import Settings
from app.utils import embedded_commands, voice_scene_builder


@pytest.fixture(autouse=True)
def no_nudge(monkeypatch):
    async def never(frame, redis):
        return False

    monkeypatch.setattr(embedded_commands, "nudge_embedded_frame", never)


def js_app(permissions=None, settings=None) -> dict:
    config: dict = {"name": "Thing"}
    if permissions is not None:
        config["permissions"] = permissions
    if settings is not None:
        config["settings"] = settings
    return {"sources": {"config.json": json.dumps(config), "app.ts": "export function get() { return 1 }"}}


def scene(scene_id="clock-1", **apps) -> dict:
    return {
        "id": scene_id,
        "name": "Clock",
        "settings": {"execution": "interpreted"},
        "fields": [],
        "nodes": [{"id": "a", "type": "app", "data": {"keyword": name}} for name in apps],
        "edges": [],
        "apps": apps,
    }


async def code_frame(async_client, db) -> Frame:
    frame = await device_frame(async_client, db)
    saved = scene(thing=js_app(["assets"], ["openAI"]))
    frame.scenes = [{**saved, "default": True, "eventMap": [{"on": "button"}], "layout": {"sceneId": "bar"}}]
    db.add(frame)
    db.commit()
    return frame


async def post(client, frame, body):
    return await client.post(f"/api/frames/{frame.id}/panel/code", json=body, headers=auth(frame))


def commands(db, frame, kind):
    return db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id, FrameCommand.type == kind).all()


@pytest.mark.asyncio
async def test_save_changes_the_scene_and_keeps_what_the_install_holds(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    changed = scene(thing=js_app(["assets"], ["openAI"]))
    changed["name"] = "Big clock"
    # The device's own marks never replace the plane's.
    changed["default"] = False
    response = await post(no_auth_client, frame, {"action": "save", "scene": changed, "show": True})
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    db.refresh(frame)
    assert len(frame.scenes) == 1
    assert frame.scenes[0]["name"] == "Big clock"
    assert frame.scenes[0]["default"] is True
    assert frame.scenes[0]["eventMap"] == [{"on": "button"}]
    assert frame.scenes[0]["layout"] == {"sceneId": "bar"}
    switch = commands(db, frame, "set_current_scene")
    assert switch and switch[-1].payload["scene_id"] == "clock-1"


@pytest.mark.asyncio
async def test_save_adds_a_new_scene_but_not_as_the_default(async_client, no_auth_client, db, monkeypatch):
    frame = await code_frame(async_client, db)

    async def showing(redis, frame):
        return "clock-1"

    monkeypatch.setattr(panel_code, "_active_scene", showing)
    new = {**scene("weather", thing=js_app([])), "default": True}
    response = await post(no_auth_client, frame, {"action": "save", "scene": new, "show": False})
    assert response.status_code == 200, response.text
    db.refresh(frame)
    assert [s["id"] for s in frame.scenes] == ["clock-1", "weather"]
    assert "default" not in frame.scenes[1]
    switch = commands(db, frame, "set_current_scene")
    assert switch and switch[-1].payload["scene_id"] == "clock-1"


@pytest.mark.asyncio
async def test_save_never_widens_what_a_scene_may_do(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    for apps, needs in [
        ({"thing": js_app(["assets", "frame"], ["openAI"])}, ["frame"]),
        ({"thing": js_app(["assets"], ["openAI", "unsplash"])}, ["key:unsplash"]),
        ({"thing": js_app(["assets"], ["openAI"]), "other": js_app(["code"])}, ["code"]),
    ]:
        response = await post(no_auth_client, frame, {"action": "save", "scene": scene(**apps)})
        assert response.status_code == 403, response.text
        assert response.json() == {"ok": False, "error": "needs_owner", "needs": needs}
    # A new scene: no red permission, no settings key; reading assets is fine.
    response = await post(no_auth_client, frame, {"action": "save", "scene": scene("new", thing=js_app(["shell"], ["openAI"]))})
    assert response.json()["needs"] == ["shell", "key:openAI"]
    # A built-in app counts by its own config.json.
    chromium = {**scene("shot"), "nodes": [{"id": "c", "type": "app", "data": {"keyword": "data/chromiumScreenshot"}}]}
    response = await post(no_auth_client, frame, {"action": "save", "scene": chromium})
    assert response.json()["needs"] == ["shell"]
    # Code that calls a power counts whatever its list says: the owner's next
    # save would stamp it in.
    sneaky = js_app([])
    sneaky["sources"]["app.ts"] = "export function get() { return frameos.code('source', 'x') }"
    response = await post(no_auth_client, frame, {"action": "save", "scene": scene("new", thing=sneaky)})
    assert response.json()["needs"] == ["code"]
    writes = js_app(["assets"])
    writes["sources"]["app.ts"] = "frameos.openAssetStream('log.txt', 'a')"
    response = await post(no_auth_client, frame, {"action": "save", "scene": scene(thing=writes)})
    assert response.json()["needs"] == ["assets-write"]
    reads = js_app(["assets"], ["openAI"])
    reads["sources"]["app.ts"] = "frameos.openAssetStream('log.txt', 'r'); frameos.readAsset('x')"
    assert (await post(no_auth_client, frame, {"action": "save", "scene": scene(thing=reads)})).status_code == 200
    ok = await post(no_auth_client, frame, {"action": "save", "scene": scene("new", thing=js_app(["assets"]))})
    assert ok.status_code == 200, ok.text
    db.refresh(frame)
    assert [s["id"] for s in frame.scenes] == ["clock-1", "new"]


@pytest.mark.asyncio
async def test_save_refuses_what_no_frame_holds(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    for bad, error in [
        ("nope", "invalid_scene"),
        ({"name": "no id"}, "invalid_scene"),
        ({**scene("system/sceneSwitcher")}, "invalid_scene"),
        ({**scene("x"), "settings": {"execution": "compiled"}}, "scene_requires_compilation"),
        ({**scene("lay"), "settings": {"execution": "interpreted", "isLayout": True}}, "invalid_layout"),
    ]:
        response = await post(no_auth_client, frame, {"action": "save", "scene": bad})
        assert response.status_code == 400
        assert response.json()["error"] == error
    db.refresh(frame)
    assert [s["id"] for s in frame.scenes] == ["clock-1"]


@pytest.mark.asyncio
async def test_nothing_while_the_settings_on_the_screen_are_off(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    frame.frame_settings_on_screen = False
    db.add(frame)
    db.commit()
    response = await post(no_auth_client, frame, {"action": "save", "scene": scene()})
    assert response.status_code == 403
    assert response.json()["error"] == "panel_locked"


@pytest.mark.asyncio
async def test_a_wrong_key_is_refused(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    response = await no_auth_client.post(
        f"/api/frames/{frame.id}/panel/code", json={"action": "save"}, headers={"Authorization": "Bearer nope"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_ask_needs_an_openai_key(async_client, no_auth_client, db):
    frame = await code_frame(async_client, db)
    response = await post(no_auth_client, frame, {"action": "ask", "prompt": "A clock"})
    assert response.status_code == 503
    assert response.json()["error"] == "ai_unavailable"


@pytest.mark.asyncio
async def test_ask_runs_the_scene_ai_typed_and_saves_nothing(async_client, no_auth_client, db, monkeypatch):
    frame = await code_frame(async_client, db)
    db.add(Settings(project_id=frame.project_id, key="openAI", value={"backendApiKey": "sk-test"}))
    db.commit()
    calls = []

    async def build(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "scene": {**(kwargs["base"] or scene("made")), "name": "Built"}, "summary": "A clock."}

    monkeypatch.setattr(voice_scene_builder, "build_scene_by_voice", build)
    response = await post(no_auth_client, frame, {"action": "ask", "prompt": "  Bigger please ", "scene": scene()})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "scene": {**scene(), "name": "Built"}, "summary": "A clock."}
    assert calls[0]["asked"] == "typed"
    assert calls[0]["request"] == "Bigger please"
    assert calls[0]["base"]["id"] == "clock-1"
    db.refresh(frame)
    assert frame.scenes[0]["name"] == "Clock"

    async def fails(**kwargs):
        return {"ok": False, "error": "render_failed", "detail": "boom"}

    monkeypatch.setattr(voice_scene_builder, "build_scene_by_voice", fails)
    response = await post(no_auth_client, frame, {"action": "ask", "prompt": "x"})
    assert response.json() == {"ok": False, "error": "render_failed", "detail": "boom"}
    empty = await post(no_auth_client, frame, {"action": "ask", "prompt": "  "})
    assert empty.json()["error"] == "empty_prompt"


def test_the_typed_context_is_not_the_spoken_one():
    spoken = voice_scene_builder.builder_context("frame", "a clock", None, None)
    typed = voice_scene_builder.builder_context("frame", "a clock", None, None, "typed")
    assert "by voice" in spoken and "The spoken request: a clock" in spoken
    assert "typed, on the frame's screen" in typed and "The typed request: a clock" in typed
    assert "code editor as a draft" in typed
