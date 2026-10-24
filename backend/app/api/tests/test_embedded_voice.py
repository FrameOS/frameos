"""Voice chat (docs/voice-chat.md): an ESP32 frame streams PCM chunks to
POST /api/frames/{id}/embedded/voice/{session}, the closing chunk is
transcribed and answered by the AI chat with the frame-scoped voice tools.
OpenAI is a scripted stream_response and a stubbed transcription."""

import json
import struct

import pytest

from app.api.tests.test_ai_chat import ScriptedOpenAi, call, tool_outputs
from app.api.tests.test_embedded_device import auth, device_frame
from app.models.chat import Chat, ChatMessage
from app.models.frame_command import FrameCommand
from app.models.settings import Settings
from app.utils import ai_chat_agent, embedded_commands, voice_chat
from app.utils.voice_chat import (
    VOICE_MAX_AUDIO_BYTES,
    VOICE_TOOL_DEFINITIONS,
    VoiceSessionStore,
    build_voice_system_prompt,
    pcm_to_wav,
)

SESSION = "0123456789abcdef"
SECOND_OF_SILENCE = bytes(32_000)
# A loud square wave: what a sentence looks like to the silence gate.
SECOND_OF_SPEECH = b"\x00\x40\x00\xc0" * 8000


def scenes() -> list[dict]:
    return [
        {"id": "clock-1", "name": "Clock", "default": True, "nodes": [], "edges": []},
        {"id": "cal-2", "name": "Calendar", "nodes": [], "edges": []},
    ]


async def voice_frame(async_client, db, *, api_key: str | None = "sk-test", unsplash_key: str | None = None, image_key: str | None = None):
    frame = await device_frame(async_client, db)
    frame.scenes = scenes()
    db.add(frame)
    # One row per (project, key): a second frame in the test's project rewrites them.
    for key, value in (
        ("openAI", {**({"backendApiKey": api_key} if api_key else {}), **({"apiKey": image_key} if image_key else {})}),
        ("unsplash", {"accessKey": unsplash_key} if unsplash_key else {}),
    ):
        row = db.query(Settings).filter(Settings.project_id == frame.project_id, Settings.key == key).first()
        if row is None:
            db.add(Settings(project_id=frame.project_id, key=key, value=value))
        else:
            row.value = value
    db.commit()
    return frame


@pytest.fixture(autouse=True)
def no_nudge(monkeypatch):
    """The frame has no reachable host in tests; the queue waits for its pull."""

    async def never(frame, redis):
        return False

    monkeypatch.setattr(embedded_commands, "nudge_embedded_frame", never)


@pytest.fixture
def heard(monkeypatch):
    """What the transcription "hears"; records the PCM it was given."""
    calls: list[dict] = []
    text = {"value": "switch to the calendar please"}

    async def fake_transcribe(pcm, *, api_key, prompt=None, http_client=None):
        calls.append({"pcm": pcm, "api_key": api_key, "prompt": prompt})
        return text["value"]

    monkeypatch.setattr(voice_chat, "transcribe_pcm", fake_transcribe)
    return {"calls": calls, "text": text}


def url(frame, seq: int, done: int = 0, session: str = SESSION) -> str:
    return f"/api/frames/{frame.id}/embedded/voice/{session}?seq={seq}&done={done}"


PCM_HEADERS = {"Content-Type": "audio/L16; rate=16000; channels=1"}


@pytest.mark.asyncio
async def test_a_spoken_scene_switch_is_transcribed_answered_and_queued(async_client, no_auth_client, db, redis, heard, monkeypatch):
    frame = await voice_frame(async_client, db)
    openai = ScriptedOpenAi([
        ("", [call("list_scenes", {}, "c1")]),
        ("", [call("activate_scene", {"scene_id": "cal-2"}, "c2")]),
        ("Switched to Calendar.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)

    # Two seconds of speech, a chunk each, then the release with the rest.
    for seq in range(2):
        response = await no_auth_client.post(url(frame, seq), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
        assert response.status_code == 202, response.text
        assert response.json() == {"ok": True, "bytes": 32_000 * (seq + 1)}
    response = await no_auth_client.post(url(frame, 2, done=1), content=SECOND_OF_SPEECH[:8000], headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": True,
        "transcript": "switch to the calendar please",
        "reply": "Switched to Calendar.",
        "tools": ["list_scenes", "activate_scene"],
    }

    # Every chunk reached the transcription, in order, with the scene names as its hint.
    assert heard["calls"][0]["pcm"] == SECOND_OF_SPEECH * 2 + SECOND_OF_SPEECH[:8000]
    assert heard["calls"][0]["prompt"] == "Clock, Calendar"
    assert heard["calls"][0]["api_key"] == "sk-test"

    # The model saw the voice prompt, the frame's context, and ONLY the four
    # voice tools: a frame's token must not drive the account's MCP tools.
    first = openai.requests[0]
    assert first["instructions"] == build_voice_system_prompt()
    assert [tool["name"] for tool in first["tools"]] == [
        "list_scenes", "activate_scene", "set_scene_state", "render_now", "show_image", "rotate_frame",
    ]
    context = first["input"][0]["content"][0]["text"]
    assert "Calendar (cal-2)" in context and "ESP32 Frame" in context
    assert "spoke this into the frame's microphone" in context
    # No Unsplash or OpenAI image key in this project: the model is told so.
    assert "- Picture sources for show_image: none" in context
    assert first["input"][-1]["content"][0]["text"] == "switch to the calendar please"
    outputs = tool_outputs(openai.requests[2])
    assert '"Calendar"' in outputs["c1"] and outputs["c1"].startswith('<untrusted_data source="frame_scenes">')
    assert json.loads(outputs["c2"])["ok"] is True

    # The switch is on the frame's command queue, the way the workspace's would be.
    commands = db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id).all()
    assert [(c.type, c.payload) for c in commands] == [("set_current_scene", {"scene_id": "cal-2"})]

    # The exchange is the frame's voice chat: one per frame, under the frame.
    chat = db.query(Chat).filter(Chat.project_id == frame.project_id).one()
    assert chat.frame_id == frame.id
    messages = db.query(ChatMessage).filter(ChatMessage.chat_id == chat.id).order_by(ChatMessage.created_at).all()
    assert [(m.role, m.content, m.tool) for m in messages] == [
        ("user", "switch to the calendar please", "voice"),
        ("assistant", "Switched to Calendar.", "voice"),
    ]

    # A second session has the first as history.
    openai2 = ScriptedOpenAi([("Back on the Clock.", [])])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai2)
    heard["text"]["value"] = "and back"
    response = await no_auth_client.post(url(frame, 0, done=1, session="second-session"), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    texts = [item["content"][0]["text"] for item in openai2.requests[0]["input"] if "content" in item]
    assert texts[1:] == ["switch to the calendar please", "Switched to Calendar.", "and back"]
    assert db.query(Chat).filter(Chat.project_id == frame.project_id).count() == 1


@pytest.mark.asyncio
async def test_set_scene_state_and_render_now_queue_their_verbs(async_client, no_auth_client, db, redis, heard, monkeypatch):
    frame = await voice_frame(async_client, db)
    await redis.set(f"frame:{frame.id}:active_scene", "cal-2")
    openai = ScriptedOpenAi([
        ("", [call("set_scene_state", {"state": {"text": "buy milk"}}, "c1"), call("render_now", {}, "c2")]),
        ("The board says buy milk.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    heard["text"]["value"] = "write buy milk on the board"

    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert response.json()["tools"] == ["set_scene_state", "render_now"]
    # The showing scene is in the context, so "the board" resolves without a tool call.
    assert '"name": "Calendar"' in openai.requests[0]["input"][0]["content"][0]["text"]
    commands = db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id).order_by(FrameCommand.created_at).all()
    assert [(c.type, c.payload) for c in commands] == [
        ("scene_event", {"name": "setSceneState", "payload": {"state": {"text": "buy milk"}, "render": True}}),
        ("render", None),
    ]


@pytest.mark.asyncio
async def test_an_unknown_scene_queues_nothing(async_client, no_auth_client, db, redis, heard, monkeypatch):
    frame = await voice_frame(async_client, db)
    openai = ScriptedOpenAi([
        ("", [call("activate_scene", {"scene_id": "nope"}, "c1")]),
        ("There is no such scene; the frame has Clock and Calendar.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert json.loads(tool_outputs(openai.requests[1])["c1"]) == {"ok": False, "error": "unknown_scene", "scenes": ["clock-1", "cal-2"]}
    assert db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id).count() == 0


@pytest.mark.asyncio
async def test_show_image_previews_a_picture_scene_next_to_the_saved_ones(async_client, no_auth_client, db, redis, heard, monkeypatch):
    from app.api.embedded_device import embedded_settings_payload

    frame = await voice_frame(async_client, db, unsplash_key="un-key", image_key="sk-images")
    openai = ScriptedOpenAi([
        ("", [call("show_image", {"query": "a banana"}, "c1")]),
        ("Here is a banana.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    heard["text"]["value"] = "show me a banana"
    # Before: the saved scenes declare no service settings, so the device gets none.
    assert embedded_settings_payload(db, frame) == {}

    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert response.json()["tools"] == ["show_image"]
    # Both keys are set: the context names both sources, photo first, and the
    # unnamed source is the photo.
    assert "- Picture sources for show_image: photo, generated" in openai.requests[0]["input"][0]["content"][0]["text"]
    outcome = json.loads(tool_outputs(openai.requests[1])["c1"])
    assert outcome["ok"] is True and outcome["source"] == "photo" and outcome["scene"] == "Voice: a banana"

    # A preview push: the frame's saved scenes plus the picture scene, the
    # picture showing — the editor's "Preview on frame", two queue rows.
    commands = db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id).order_by(FrameCommand.created_at).all()
    assert [c.type for c in commands] == ["set_scenes", "set_current_scene"]
    preview = commands[0].payload["_preview"]
    assert [scene["name"] for scene in preview["scenes"]] == ["Clock", "Calendar", "Voice: a banana"]
    picture = preview["scenes"][-1]
    assert preview["scene_id"] == picture["id"] == commands[1].payload["scene_id"]
    app_node = next(node for node in picture["nodes"] if node["data"]["keyword"] == "unsplash")
    assert app_node["data"]["config"] == {"search": "a banana"}
    assert picture["apps"]["unsplash"]["origin"] == "repo/apps/image/unsplash"
    assert "app.ts" in picture["apps"]["unsplash"]["sources"]
    assert picture["settings"]["refreshInterval"] == 3600
    # The device's settings pull now carries the Unsplash key the preview needs.
    db.expire_all()
    assert embedded_settings_payload(db, frame) == {"unsplash": {"accessKey": "un-key"}}
    # The workspace sees the preview for what it is: a scene shown for now,
    # not in the saved list, from the voice chat.
    shown = (await async_client.get(f"/api/frames/{frame.id}")).json()["frame"]["scene_preview"]
    assert shown["scene_id"] == picture["id"] and shown["name"] == "Voice: a banana" and shown["source"] == "voice"
    assert shown["at"]
    listed = (await async_client.get("/api/frames")).json()["frames"]
    assert next(f for f in listed if f["id"] == frame.id)["scene_preview"]["name"] == "Voice: a banana"
    # And can install it: the previewed scene itself, for the saved list.
    kept = (await async_client.get(f"/api/frames/{frame.id}/scene_preview")).json()
    assert kept["preview"]["name"] == "Voice: a banana" and kept["scene"]["id"] == picture["id"]
    assert kept["scene"]["apps"]["unsplash"]["origin"] == "repo/apps/image/unsplash"

    # A second picture: the new preview replaces the first on the frame (the
    # saved scenes plus ONE picture scene, never a growing list), and the
    # first push's row loses its scene bundle — only the newest is served.
    openai_again = ScriptedOpenAi([
        ("", [call("show_image", {"query": "an apple", "source": "generated"}, "c1")]),
        ("Here is an apple.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai_again)
    heard["text"]["value"] = "now an apple"
    response = await no_auth_client.post(url(frame, 0, done=1, session="apple-session-1"), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    db.expire_all()
    pushes = (
        db.query(FrameCommand)
        .filter(FrameCommand.frame_id == frame.id, FrameCommand.type == "set_scenes")
        .order_by(FrameCommand.created_at)
        .all()
    )
    assert [scene["name"] for scene in pushes[-1].payload["_preview"]["scenes"]] == ["Clock", "Calendar", "Voice: an apple"]
    assert pushes[0].payload["_preview"]["scenes"] == [] and pushes[0].payload["_preview"]["spent"] is True
    # The spent row still knows what it previewed; the frame's preview is the newest.
    assert pushes[0].payload["_preview"]["name"] == "Voice: a banana"
    assert (await async_client.get(f"/api/frames/{frame.id}")).json()["frame"]["scene_preview"]["name"] == "Voice: an apple"
    assert (await async_client.get(f"/api/frames/{frame.id}/scene_preview")).json()["scene"]["name"] == "Voice: an apple"
    apple = pushes[-1].payload["_preview"]["scenes"][-1]
    assert next(node for node in apple["nodes"] if node["data"]["keyword"] == "openaiImage")["data"]["config"] == {"prompt": "an apple"}
    assert apple["settings"]["refreshInterval"] == 86400
    # The settings pull follows the newest preview: the apple scene declares
    # openAI, and the banana scene (unsplash) is no longer on the frame.
    assert set(embedded_settings_payload(db, frame)) == {"openAI"}
    # Nothing to install once the saved list is pushed again (a deploy row is the newest).
    from app.utils.frame_commands import enqueue_frame_command

    enqueue_frame_command(db, frame, "set_scenes", {"checksum": "deploy"})
    assert (await async_client.get(f"/api/frames/{frame.id}/scene_preview")).status_code == 404
    assert (await async_client.get(f"/api/frames/{frame.id}")).json()["frame"]["scene_preview"] is None

    # Asked for art with only a photo key: told which sources exist, nothing queued.
    frame2 = await voice_frame(async_client, db, unsplash_key="un-key")
    openai2 = ScriptedOpenAi([
        ("", [call("show_image", {"query": "a cat in space", "source": "generated"}, "c1")]),
        ("I can only find photos on this frame.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai2)
    response = await no_auth_client.post(url(frame2, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame2), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert json.loads(tool_outputs(openai2.requests[1])["c1"]) == {"ok": False, "error": "source_unavailable", "available": ["photo"]}
    assert db.query(FrameCommand).filter(FrameCommand.frame_id == frame2.id).count() == 0


@pytest.mark.asyncio
async def test_rotate_frame_rotates_the_frame(async_client, no_auth_client, db, redis, heard, monkeypatch):
    from app.api.embedded_device import embedded_settings_etag

    frame = await voice_frame(async_client, db)
    etag_before = embedded_settings_etag(db, frame)
    openai = ScriptedOpenAi([
        ("", [call("rotate_frame", {"degrees": 90}, "c1"), call("rotate_frame", {"degrees": 45}, "c2")]),
        ("Rotated the frame; it restarts to apply it.", []),
    ])
    monkeypatch.setattr(ai_chat_agent, "stream_response", openai)
    heard["text"]["value"] = "rotate 90 degrees"
    # The context carries the rotation, so "another 90" can be worked out.
    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200, response.text
    assert "- Rotation: 0 degrees clockwise" in openai.requests[0]["input"][0]["content"][0]["text"]
    # Every call the model made, the refused one included (the loop's count).
    assert response.json()["tools"] == ["rotate_frame", "rotate_frame"]
    outputs = tool_outputs(openai.requests[1])
    assert json.loads(outputs["c1"]) == {"ok": True, "settings": {"rotate": 90}, "restart": True, "status": "queued"}
    assert json.loads(outputs["c2"]) == {"ok": False, "error": "degrees must be 0, 90, 180 or 270"}
    # The frame row changed (the ETag moved) AND a pull-backed set_settings
    # row waits: that is what makes the device fetch its settings on its
    # next pull, and what the pull's new ETag acks.
    db.expire_all()
    assert frame.rotate == 90
    assert embedded_settings_etag(db, frame) != etag_before
    rows = db.query(FrameCommand).filter(FrameCommand.frame_id == frame.id).all()
    assert [(row.type, row.status, row.detail) for row in rows] == [("set_settings", "pending", "rotate=90")]


@pytest.mark.asyncio
async def test_the_frames_token_is_the_only_key(async_client, no_auth_client, db, redis, heard):
    frame = await voice_frame(async_client, db)
    other = await device_frame(async_client, db)
    assert (await no_auth_client.post(url(frame, 0), content=SECOND_OF_SPEECH, headers=PCM_HEADERS)).status_code == 401
    assert (await no_auth_client.post(url(frame, 0), content=SECOND_OF_SPEECH, headers={**auth(other), **PCM_HEADERS})).status_code == 401
    assert heard["calls"] == []


@pytest.mark.asyncio
async def test_a_gap_in_the_chunks_ends_the_session(async_client, no_auth_client, db, redis, heard):
    frame = await voice_frame(async_client, db)
    assert (await no_auth_client.post(url(frame, 0), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})).status_code == 202
    response = await no_auth_client.post(url(frame, 2), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 409
    assert response.json()["detail"] == "seq_mismatch"
    # The session is gone: its next chunk is a new session's first, or nothing.
    response = await no_auth_client.post(url(frame, 1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 409
    assert response.json()["detail"] == "unknown_session"
    assert heard["calls"] == []


@pytest.mark.asyncio
async def test_without_an_openai_key_the_frame_hears_an_error(async_client, no_auth_client, db, redis, heard):
    frame = await voice_frame(async_client, db, api_key=None)
    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False and body["error"] == "ai_unavailable"
    assert heard["calls"] == []


@pytest.mark.asyncio
async def test_silence_is_nothing_heard(async_client, no_auth_client, db, redis, heard, monkeypatch):
    frame = await voice_frame(async_client, db)
    heard["text"]["value"] = "   "
    monkeypatch.setattr(ai_chat_agent, "stream_response", ScriptedOpenAi([]))
    response = await no_auth_client.post(url(frame, 0, done=1), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.json() == {"ok": False, "error": "nothing_heard", "detail": "the transcription came back empty"}
    # A recording too short to hold a word is not even sent to OpenAI.
    response = await no_auth_client.post(url(frame, 0, done=1, session="too-short-0001"), content=bytes(2000), headers={**auth(frame), **PCM_HEADERS})
    assert response.json()["error"] == "nothing_heard"
    assert len(heard["calls"]) == 1
    # Nor is silence: a transcription of nothing comes back as the prompt
    # (the scene names), so the level is checked first.
    response = await no_auth_client.post(url(frame, 0, done=1, session="silence-0001"), content=SECOND_OF_SILENCE, headers={**auth(frame), **PCM_HEADERS})
    assert response.json()["error"] == "nothing_heard"
    assert response.json()["detail"].startswith("silence")
    assert len(heard["calls"]) == 1
    # And a transcript that IS the prompt is noise that got through the gate.
    heard["text"]["value"] = "Clock, Calendar."
    response = await no_auth_client.post(url(frame, 0, done=1, session="echo-0001"), content=SECOND_OF_SPEECH, headers={**auth(frame), **PCM_HEADERS})
    assert response.json() == {"ok": False, "error": "nothing_heard", "detail": "only the scene names came back"}
    assert db.query(ChatMessage).count() == 0


@pytest.mark.asyncio
async def test_a_chunk_over_the_cap_is_refused(async_client, no_auth_client, db, redis, heard):
    frame = await voice_frame(async_client, db)
    response = await no_auth_client.post(url(frame, 0), content=bytes(64 * 1024 + 1), headers={**auth(frame), **PCM_HEADERS})
    assert response.status_code == 413
    assert heard["calls"] == []


def test_the_session_store_caps_and_forgets():
    clock = {"now": 100.0}
    store = VoiceSessionStore(ttl_seconds=60, now=lambda: clock["now"])
    session = store.append(7, "s1", 0, b"ab")
    assert not isinstance(session, str) and session.received == 2
    assert store.append(7, "s1", 1, b"cd").audio() == b"abcd"
    # Another frame's session with the same id is another session.
    assert store.append(8, "s1", 0, b"x").frame_id == 8
    # Past the 30 s of audio the session is dropped.
    assert store.append(7, "s1", 2, bytes(VOICE_MAX_AUDIO_BYTES)) == "session_too_long"
    assert store.take(7, "s1") is None
    # A session nobody wrote to for the TTL is forgotten.
    clock["now"] = 161.0
    assert store.append(8, "s1", 1, b"y") == "unknown_session"
    assert len(store) == 0


def test_pcm_becomes_a_16khz_mono_wav():
    wav = pcm_to_wav(b"\x01\x02\x03\x04")
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    channels, rate, byte_rate, block_align, bits = struct.unpack("<HIIHH", wav[22:36])
    assert (channels, rate, byte_rate, block_align, bits) == (1, 16000, 32000, 2, 16)
    assert wav[36:40] == b"data" and struct.unpack("<I", wav[40:44])[0] == 4
    assert wav[44:] == b"\x01\x02\x03\x04"


def test_the_voice_tools_match_the_cloud():
    """The prompt and the tool definitions are the same on both planes
    (docs/voice-chat.md): the cloud's voice.ts carries copies."""
    from pathlib import Path

    cloud = (Path(__file__).resolve().parents[4] / "cloud" / "apps" / "auth-web" / "src" / "lib" / "ai" / "voice.ts").read_text()
    for tool in VOICE_TOOL_DEFINITIONS:
        assert f'name: "{tool["name"]}"' in cloud, tool["name"]
    for line in build_voice_system_prompt().splitlines():
        assert line in cloud, line
