"""The AI chat (docs/ai-chat.md): POST /api/projects/{id}/ai/chat streams the
same NDJSON events as the cloud's, runs the backend's own MCP tools
in-process, and delivers scenes to the editor through the editor tools.
OpenAI is replaced by a scripted stream_response."""

import json
from pathlib import Path

import pytest

from app.models import new_frame
from app.models.chat import Chat, ChatMessage
from app.models.settings import Settings
from app.utils import ai_chat_agent
from app.utils.ai_chat_scene import apply_scene_patch, apply_source_edits
from app.utils.ai_chat_tools import EXCLUDED_MCP_TOOLS

FIXTURES = json.loads((Path(__file__).resolve().parents[4] / "docs" / "ai-scene-patch-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=[case["name"] for case in FIXTURES["cases"]])
def test_patch_and_edit_fixtures_match_the_cloud(case):
    expected = case["expected"]
    if case["kind"] == "patch":
        scene, changes, issues = apply_scene_patch(FIXTURES["base"], case["args"])
        assert issues == expected["issues"]
        assert changes == expected["changes"]
    else:
        scene, issues, summary = apply_source_edits(FIXTURES["base"], case["args"])
        assert issues == expected["issues"]
        assert summary == expected["summary"]
    if expected["scene"] is not None:
        assert scene == expected["scene"]


def call(name: str, arguments: dict, call_id: str) -> dict:
    return {"type": "function_call", "name": name, "arguments": json.dumps(arguments), "call_id": call_id}


class ScriptedOpenAi:
    """Each round returns the next scripted (text, calls); records what it was sent."""

    def __init__(self, rounds: list[tuple[str, list[dict]]]):
        self.rounds = rounds
        self.requests: list[dict] = []

    async def __call__(self, **kwargs):
        self.requests.append({
            "input": json.loads(json.dumps(kwargs["input_items"])),
            "tools": kwargs["tools"],
            "instructions": kwargs["instructions"],
        })
        text, calls = self.rounds[len(self.requests) - 1]
        if text:
            await kwargs["on_text_delta"](text)
        output = ([{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}] if text else []) + calls
        return ai_chat_agent.StreamedResponse(output=output, function_calls=calls, status="completed")


def events_of(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def tool_outputs(request: dict) -> dict[str, object]:
    return {item["call_id"]: item["output"] for item in request["input"] if item.get("type") == "function_call_output"}


async def _setup(db, redis):
    frame = await new_frame(db, redis, "Kitchen", "kitchen.local", "backend.local")
    db.add(Settings(project_id=frame.project_id, key="openAI", value={"backendApiKey": "sk-test"}))
    db.commit()
    return frame


@pytest.mark.asyncio
async def test_frameless_chat_finds_a_frame_with_the_mcp_tools(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis)
    openai = ScriptedOpenAi([
        ("", [call("frames_list", {}, "c1")]),
        ("", [call("frame_get", {"frame_id": frame.id}, "c2")]),
        ("The kitchen frame is idle.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)

    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat",
        json={"prompt": "How is the kitchen frame?", "chatId": "home-chat-1", "history": []},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/x-ndjson")
    events = events_of(response)
    chat = db.query(Chat).filter(Chat.project_id == frame.project_id).one()
    assert events[0] == {"type": "chat", "chatId": chat.id}
    assert events[-1] == {"type": "done", "tool": "reply", "reply": "The kitchen frame is idle."}
    assert {"type": "tool", "name": "frames_list", "label": "Frames list", "status": "done"} in events

    # The model gets the MCP tools, without project_id (the chat fills it in)
    # and without the ones that make no sense inside a chat.
    tools = {tool["name"]: tool for tool in openai.requests[0]["tools"]}
    assert {"frames_list", "frame_get", "frame_screenshot", "frame_update", "create_scenes", "render_scene"} <= set(tools)
    assert not EXCLUDED_MCP_TOOLS & set(tools)
    assert "project_id" not in tools["frame_get"]["parameters"]["properties"]
    assert "confirm" in tools["frame_update"]["parameters"]["required"]

    # Tool results reach the model inside the untrusted frame.
    outputs = tool_outputs(openai.requests[2])
    assert "Kitchen" in outputs["c1"] and outputs["c1"].startswith('<untrusted_data source="frames_list">')
    assert "kitchen.local" in outputs["c2"]

    # Deleting a frame stays in the workspace.
    assert "frame_delete" not in tools

    # The chat is stored without a frame, and lists without one.
    assert chat.frame_id is None
    messages = db.query(ChatMessage).filter(ChatMessage.chat_id == chat.id).order_by(ChatMessage.created_at).all()
    assert [(m.role, m.content) for m in messages] == [
        ("user", "How is the kitchen frame?"),
        ("assistant", "The kitchen frame is idle."),
    ]
    listed = await async_client.get(f"/api/projects/{frame.project_id}/ai/chats")
    assert listed.status_code == 200
    assert [entry["id"] for entry in listed.json()["chats"]] == [chat.id]
    # The history lists it under its first question, as the cloud does.
    assert listed.json()["chats"][0]["title"] == "How is the kitchen frame?"
    assert listed.json()["chats"][0]["messageCount"] == 2
    # The frames home's drawer pages through the chats about no frame only.
    on_frame = Chat(project_id=frame.project_id, frame_id=frame.id, context_type="frame")
    db.add(on_frame)
    db.flush()
    db.add(ChatMessage(project_id=frame.project_id, chat_id=on_frame.id, role="user", content="Kitchen?"))
    db.commit()
    everything = await async_client.get(f"/api/projects/{frame.project_id}/ai/chats")
    assert {entry["id"] for entry in everything.json()["chats"]} == {chat.id, on_frame.id}
    home = await async_client.get(f"/api/projects/{frame.project_id}/ai/chats?frameless=1")
    assert [entry["id"] for entry in home.json()["chats"]] == [chat.id]
    detail = await async_client.get(f"/api/projects/{frame.project_id}/ai/chats/home-chat-1")
    assert detail.status_code == 200 and detail.json()["chat"]["frameId"] is None


@pytest.mark.asyncio
async def test_confirm_is_still_required_by_the_mcp_tool(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis)
    openai = ScriptedOpenAi([
        ("", [call("frame_reboot", {"frame_id": frame.id}, "c1")]),
        ("I need your go-ahead.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "reboot it", "frameId": frame.id}
    )
    assert response.status_code == 200
    output = json.loads(tool_outputs(openai.requests[1])["c1"])
    assert output["ok"] is False and "confirm" in output["error"]


@pytest.mark.asyncio
async def test_scenes_are_delivered_to_the_editor_and_patched(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis)
    scene = {
        "id": "open-scene",
        "name": "Hello",
        "nodes": [
            {"id": "render", "type": "event", "data": {"keyword": "render"}},
            {"id": "t", "type": "app", "data": {"keyword": "render/text", "config": {"text": "Hello"}}},
        ],
        "edges": [{"id": "e", "source": "render", "target": "t", "sourceHandle": "next", "targetHandle": "prev"}],
    }
    new_scene = {
        "id": "new-scene",
        "name": "Clock",
        "nodes": [{"id": "render", "type": "event", "data": {"keyword": "render"}}],
        "edges": [],
    }
    openai = ScriptedOpenAi([
        ("", [
            call("patch_scene", {"set_nodes": [{"id": "t", "type": "app", "data": {"keyword": "render/text", "config": {"text": "Bye"}}}]}, "c1"),
            call("create_scenes", {"title": "A clock", "scenes": [new_scene]}, "c2"),
            call("create_scenes", {"title": "Broken", "scenes": [{"id": "x", "name": "x", "nodes": [{"id": "a", "type": "app", "data": {"keyword": "no/such/app"}}], "edges": []}]}, "c3"),
        ]),
        ("Done: the text says Bye, and there is a new clock scene.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat",
        json={"prompt": "say bye and add a clock", "frameId": frame.id, "sceneId": "open-scene", "scene": scene},
    )
    assert response.status_code == 200, response.text
    events = events_of(response)
    delivered = [event for event in events if event["type"] == "scenes"]
    assert [event["tool"] for event in delivered] == ["modify_scene", "build_scene"]
    assert delivered[0]["scenes"][0]["id"] == "open-scene"
    assert delivered[0]["scenes"][0]["nodes"][1]["data"]["config"]["text"] == "Bye"
    assert delivered[1]["title"] == "A clock"
    assert events[-1]["tool"] == "build_scene"

    outputs = tool_outputs(openai.requests[1])
    assert json.loads(outputs["c1"])["applied"] == ["nodes: 1 replaced, 0 added"]
    broken = json.loads(outputs["c3"])
    assert broken["ok"] is False and any("render event" in issue for issue in broken["issues"])
    # The open scene is context for the model, inside the untrusted frame.
    context = openai.requests[0]["input"][0]["content"][0]["text"]
    assert "Kitchen" in context and '<untrusted_data source="open_scene">' in context


@pytest.mark.asyncio
async def test_render_scene_on_an_esp32_renders_in_the_frames_memory(async_client, db, redis, monkeypatch):
    """The E1004 aborted a scene that rendered fine everywhere else: a chat
    about an ESP32 frame renders in that frame's PSRAM, and running out comes
    back to the model as what it is."""
    from app.utils import embedded_render
    from app.utils.embedded_render import SceneRender

    frame = await _setup(db, redis)
    frame.mode = "embedded"
    frame.width, frame.height = 1200, 1600
    frame.embedded = {"hardwarePreset": "seeed_reterminal_e1004"}
    db.commit()

    asked: list[dict] = []

    async def fake_render(_frame, width, height, **kwargs):
        asked.append({"width": width, "height": height, **kwargs})
        return SceneRender(
            None,
            error="render ran out of memory",
            out_of_memory={"refusedBytes": 7_680_004, "usedBytes": 8_416_300},
            scene_logs=['{"event":"render:scene"}'],
        )

    monkeypatch.setattr(embedded_render, "render_scene", fake_render)
    monkeypatch.setattr(embedded_render, "thin_client_renderer_available", lambda: True)
    scene = {
        "id": "clock",
        "name": "Clock",
        "nodes": [{"id": "render", "type": "event", "data": {"keyword": "render"}}],
        "edges": [],
    }
    openai = ScriptedOpenAi([("", [call("render_scene", {}, "c1")]), ("It is too heavy for this frame.", [])])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat",
        json={"prompt": "how does it look?", "frameId": frame.id, "sceneId": "clock", "scene": scene},
    )
    assert response.status_code == 200, response.text

    assert asked[0]["device_limits"]["memoryBytes"] == 10_220_032
    assert asked[0]["device_limits"]["embedded"] is True
    context = openai.requests[0]["input"][0]["content"][0]["text"]
    assert "- Memory: ESP32 with 8 MB PSRAM." in context
    output = tool_outputs(openai.requests[1])["c1"]
    result = json.loads(output.split("\n", 1)[0])
    assert result["ok"] is False
    assert result["error"].startswith("Out of memory: an allocation of 7.3 MB was refused")
    assert result["rendered_in"] == "the frame's memory: ESP32 with 8 MB PSRAM"
    assert "draw into the frame's canvas" in result["note"]
    assert '<untrusted_data source="scene_render_output">' in output


@pytest.mark.asyncio
async def test_an_install_that_runs_the_frame_out_of_memory_is_refused(async_client, db, redis, monkeypatch):
    """The E1004 clock came from the frames home: scene_create, then
    frame_scene_install, with no editor and no render on the way. An install
    on a frame that renders in a few megabytes renders there first."""
    from app.models.frame import Frame
    from app.utils import embedded_render
    from app.utils.embedded_render import SceneRender

    frame = await _setup(db, redis)
    frame.mode = "embedded"
    frame.width, frame.height = 1200, 1600
    frame.embedded = {"hardwarePreset": "seeed_reterminal_e1004"}
    frame.scenes = []
    db.commit()

    fits = {"value": False}
    rendered: list[dict] = []

    async def fake_render(target, width, height, **kwargs):
        rendered.append({"frame": target.id, "width": width, "height": height, **kwargs})
        if fits["value"]:
            return SceneRender(b"\x00" * (width * height * 4))
        return SceneRender(None, error="render ran out of memory", out_of_memory={"refusedBytes": 7_680_004, "usedBytes": 8_416_300})

    monkeypatch.setattr(embedded_render, "render_scene", fake_render)
    monkeypatch.setattr(embedded_render, "thin_client_renderer_available", lambda: True)
    clock = {"id": "clock", "name": "Clock", "nodes": [{"id": "render", "type": "event", "data": {"keyword": "render"}}], "edges": []}
    install = {"frame_id": frame.id, "scenes": [clock], "confirm": True, "deploy": "none"}

    openai = ScriptedOpenAi([("", [call("frame_scene_install", install, "c1")]), ("It does not fit.", [])])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "put a clock on the kitchen wall", "chatId": "home-2"}
    )
    assert response.status_code == 200, response.text
    refused = json.loads(tool_outputs(openai.requests[1])["c1"])
    assert refused["installed"] is False
    assert refused["error"].startswith("Out of memory: an allocation of 7.3 MB was refused")
    assert refused["rendered_in"] == "the frame's memory: ESP32 with 8 MB PSRAM"
    assert rendered[0]["device_limits"]["memoryBytes"] == 10_220_032
    assert (rendered[0]["width"], rendered[0]["height"]) == (1200, 1600)
    db.expire_all()
    assert db.get(Frame, frame.id).scenes == []

    fits["value"] = True
    openai = ScriptedOpenAi([("", [call("frame_scene_install", install, "c1")]), ("Installed.", [])])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "now it fits", "chatId": "home-3"}
    )
    assert response.status_code == 200, response.text
    installed = tool_outputs(openai.requests[1])["c1"]
    assert '"installed"' in installed and "Out of memory" not in installed
    db.expire_all()
    assert [scene["name"] for scene in db.get(Frame, frame.id).scenes] == ["Clock"]


@pytest.mark.asyncio
async def test_chat_needs_an_openai_key(async_client, db, redis):
    frame = await new_frame(db, redis, "Bare", "bare.local", "backend.local")
    response = await async_client.post(f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "hi"})
    assert response.status_code == 400
    assert "OpenAI" in response.json()["detail"]


@pytest.mark.asyncio
async def test_openai_failure_is_an_error_event(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis)

    async def failing(**_kwargs):
        raise ai_chat_agent.OpenAiRequestError("Incorrect API key provided", 401)

    monkeypatch.setattr(ai_chat_agent, "stream_response", failing)
    response = await async_client.post(f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "hi"})
    events = events_of(response)
    assert events[-1] == {"type": "error", "detail": "Incorrect API key provided"}


@pytest.mark.asyncio
async def test_create_scenes_without_an_editor_points_at_the_saving_tools(async_client, db, redis, monkeypatch):
    frame = await _setup(db, redis)
    openai = ScriptedOpenAi([
        ("", [call("create_scenes", {"title": "x", "scenes": []}, "c1")]),
        ("ok", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await async_client.post(
        f"/api/projects/{frame.project_id}/ai/chat", json={"prompt": "make a clock", "editor": False}
    )
    assert response.status_code == 200
    output = json.loads(tool_outputs(openai.requests[1])["c1"])
    assert output["ok"] is False and "frame_scene_install" in output["error"]


def test_mcp_images_reach_the_model():
    """frame_screenshot answers with an image: "what's on the frame now?" is
    answered by looking at it."""
    from app.utils.ai_chat_tools import mcp_result_output

    output = mcp_result_output("frame_screenshot", {"content": [
        {"type": "text", "text": "Frame 1: what the display last rendered (68 bytes)"},
        {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
    ]})
    assert output.images == ["data:image/png;base64,iVBORw0KGgo="]
    assert output.text.startswith('<untrusted_data source="frame_screenshot">')
    sent = ai_chat_agent.function_call_output(output.text, output.images)
    assert sent[1] == {"type": "input_image", "detail": "high", "image_url": "data:image/png;base64,iVBORw0KGgo="}

    failed = mcp_result_output("frame_screenshot", {"isError": True, "content": [{"type": "text", "text": "offline"}]})
    assert json.loads(failed.text) == {"ok": False, "error": "offline"}
