"""`POST /api/frames/{id}/embedded/voice/{session}?seq=N&done=0|1`: an ESP32
frame streams what its user says while they hold LEFT+RIGHT, this answers
with the AI chat (docs/voice-chat.md).

Every chunk is raw 16 kHz 16-bit mono PCM; `seq` counts them from 0 and the
one with `done=1` (possibly empty) closes the session. Chunks sit in this
process's memory until then (app/utils/voice_chat.py VoiceSessionStore). The
closing request answers when the turn is over: the transcript, the reply and
the tools that ran, or `{"ok": false, "error": …}` for what the frame should
sound as an error. The frame's bearer is its `server_api_key`, as on every
other `/embedded` route; the tools the turn gets are the four a frame may
drive (VoiceTools), never the account's MCP tools.

The cloud's twin is cloud/apps/auth-web/app/api/frames/[frameId]/voice/[sessionId]/route.ts."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from http import HTTPStatus
from typing import Any

from arq import ArqRedis as Redis
from fastapi import Depends, Header, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.ai_chat import frame_context_block
from app.api.embedded_device import _active_scene_id, _embedded_frame_from_bearer
from app.database import get_db
from app.models.chat import Chat, ChatMessage, find_project_chat, project_chat_id
from app.models.frame import Frame
from app.models.log import new_log
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.models.frame import update_frame
from app.utils.ai_scene import CHAT_MODEL, openai_model
from app.utils.embedded_commands import nudge_embedded_frame, queue_embedded_command, queue_embedded_scene_preview
from app.utils.frame_commands import enqueue_frame_command
from app.utils.rate_limit import hit_rate_limit
from app.utils.upload_limits import read_body_limited
from app.utils.voice_chat import (
    VOICE_BYTES_PER_SECOND,
    VOICE_MAX_CHUNK_BYTES,
    VOICE_SESSIONS_PER_FRAME_PER_15_MIN,
    VoiceSessionStore,
    VoiceTools,
    VoiceTurnResult,
    image_sources_for_settings,
    transcribe_and_answer,
    voice_chat_id,
    voice_frame_context,
)
from . import api_public

__all__ = ["api_embedded_device_voice"]

SESSION_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"
# Under this much audio nobody said anything the transcription could hear;
# saying so costs no OpenAI call.
MIN_AUDIO_SECONDS = 0.3
# A scene switch waits this long for the awake frame's ack, as the event route does.
COMMAND_WAIT_SECONDS = 4.0
MAX_HISTORY_MESSAGES = 8

_sessions = VoiceSessionStore()


def voice_sessions() -> VoiceSessionStore:
    return _sessions


def _voice_chat(db: Session, frame: Frame) -> Chat:
    """The frame's voice chat: one per frame, the workspace lists it under
    the frame with its other chats."""
    project_id = int(frame.project_id)
    proposed = voice_chat_id(int(frame.id))
    chat = find_project_chat(db, project_id, proposed)
    if chat is None:
        chat = Chat(
            id=project_chat_id(project_id, proposed),
            project_id=project_id,
            frame_id=int(frame.id),
            context_type="frame",
        )
        db.add(chat)
        db.flush()
    return chat


def _history(db: Session, chat: Chat) -> list[dict[str, str]]:
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.project_id == chat.project_id, ChatMessage.chat_id == chat.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(MAX_HISTORY_MESSAGES)
        .all()
    )
    return [
        {"role": message.role, "content": message.content}
        for message in reversed(messages)
        if message.role in ("user", "assistant") and message.content and message.tool != "error"
    ]


def _failure(error: str, detail: str) -> JSONResponse:
    # 200 on purpose: the frame reads the body and sounds the error; a 5xx
    # would read as "the backend is down" when the backend is fine.
    return JSONResponse({"ok": False, "error": error, "detail": detail[:500]})


@api_public.post("/frames/{id:int}/embedded/voice/{session_id}")
async def api_embedded_device_voice(
    id: int,
    request: Request,
    session_id: str = Path(pattern=SESSION_ID_PATTERN),
    seq: int = Query(0, ge=0, le=10_000),
    done: int = Query(0, ge=0, le=1),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    authorization: str = Header(None),
):
    frame = _embedded_frame_from_bearer(db, id, authorization)
    if seq == 0 and await hit_rate_limit(
        redis, "embedded_voice", str(frame.id), limit=VOICE_SESSIONS_PER_FRAME_PER_15_MIN, window_seconds=900
    ):
        raise HTTPException(status_code=HTTPStatus.TOO_MANY_REQUESTS, detail="Too many voice sessions")
    body = await read_body_limited(request, VOICE_MAX_CHUNK_BYTES, "Audio chunk too large")
    result = _sessions.append(int(frame.id), session_id, seq, body)
    if isinstance(result, str):
        if result == "session_too_long":
            raise HTTPException(status_code=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, detail="session_too_long")
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail=result)
    if not done:
        return JSONResponse({"ok": True, "bytes": result.received}, status_code=HTTPStatus.ACCEPTED)

    session = _sessions.take(int(frame.id), session_id)
    if session is None:  # a concurrent close of the same session
        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="unknown_session")
    pcm = session.audio()

    settings = get_settings_dict(db, project_id=int(frame.project_id))
    openai_settings = settings.get("openAI") or {}
    api_key = openai_settings.get("backendApiKey")
    if not isinstance(api_key, str) or not api_key.strip():
        await new_log(db, redis, int(frame.id), "stderr", "Voice chat: no OpenAI backend API key (Settings → OpenAI)")
        return _failure("ai_unavailable", "Add an OpenAI API key for the backend in Settings → OpenAI.")
    if len(pcm) < MIN_AUDIO_SECONDS * VOICE_BYTES_PER_SECOND:
        return _failure("nothing_heard", "the recording was too short")

    active_scene_id = await _active_scene_id(redis, frame)
    chat = _voice_chat(db, frame)
    history = _history(db, chat)
    scene_names = [
        str(scene.get("name")) for scene in (frame.scenes or []) if isinstance(scene, dict) and scene.get("name")
    ]

    async def queue_command(command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await queue_embedded_command(
            db,
            redis,
            frame,
            command_type,
            payload,
            detail="voice chat",
            wait_seconds=COMMAND_WAIT_SECONDS,
            log_line=f"Voice chat queued {command_type}",
        )

    async def preview_scenes(scenes: list[dict[str, Any]], scene_id: str) -> dict[str, Any]:
        # The editor's "Preview on frame": the frame's saved scenes plus the
        # new one, with the new one showing, so the others stay selectable.
        # It holds through later pushes (frame_commands.previewed_scenes,
        # carried_preview) until it is installed or discarded.
        saved = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
        await new_log(db, redis, int(frame.id), "stdinfo", f"Voice chat previews {scenes[0].get('name')}")
        outcome = await queue_embedded_scene_preview(
            db, redis, frame, [*saved, *scenes], scene_id, wait_seconds=COMMAND_WAIT_SECONDS, source="voice"
        )
        # The workspace's preview row (scene_preview on the frame) changed:
        # say so to the open tabs, the frame row itself did not move.
        await update_frame(db, redis, frame)
        return outcome

    async def update_settings(changes: dict[str, Any]) -> dict[str, Any]:
        # Into the frame row, as the Settings panel's save does, and a
        # pull-backed set_settings row like the deploy's: the device fetches
        # its settings only when its commands pull says a deploy is waiting
        # (`sync`), and the row is acked when the pull reports the new ETag.
        # Without the row the second spoken rotation never reached the frame
        # (E1002, 2026-10-24: the first rode on a preview's pending row).
        for key, value in changes.items():
            setattr(frame, key, value)
        db.add(frame)
        db.commit()
        await update_frame(db, redis, frame)
        detail = ", ".join(f"{key}={value}" for key, value in changes.items())
        enqueue_frame_command(db, frame, "set_settings", {"_voice": True}, detail=detail)
        await new_log(db, redis, int(frame.id), "stdinfo", f"Voice chat set {detail}")
        nudged = await nudge_embedded_frame(frame, redis)
        return {"status": "queued" if not nudged else "pulled"}

    image_sources = image_sources_for_settings(settings)
    tools = VoiceTools(
        frame=frame,
        active_scene_id=active_scene_id,
        queue_command=queue_command,
        preview_scenes=preview_scenes,
        update_settings=update_settings,
        image_sources=image_sources,
    )
    outcome = await transcribe_and_answer(
        pcm=pcm,
        api_key=api_key.strip(),
        model=openai_model(openai_settings, "chatModel", CHAT_MODEL),
        reasoning_effort=openai_settings.get("chatReasoningEffort") or None,
        scene_names=scene_names,
        context_block=voice_frame_context(frame, active_scene_id, frame_context_block(frame), image_sources),
        history=history,
        tools=tools,
    )
    if not isinstance(outcome, VoiceTurnResult):
        error, detail = outcome
        await new_log(db, redis, int(frame.id), "stderr", f"Voice chat failed ({error}): {detail[:300]}")
        return _failure(error, detail)

    # Both rows land in one commit; a millisecond apart keeps the history in
    # order on a database whose default timestamp is the whole second.
    now = datetime.utcnow()
    chat.updated_at = now
    db.add(ChatMessage(project_id=chat.project_id, chat_id=chat.id, role="user", content=outcome.transcript,
                       tool="voice", created_at=now))
    db.add(ChatMessage(project_id=chat.project_id, chat_id=chat.id, role="assistant", content=outcome.reply,
                       tool="voice", created_at=now + timedelta(milliseconds=1)))
    db.commit()
    await new_log(
        db,
        redis,
        int(frame.id),
        "stdinfo",
        json.dumps({"event": "voice:turn", "transcript": outcome.transcript[:300], "reply": outcome.reply[:300],
                    "tools": outcome.tools}),
    )
    return {"ok": True, "transcript": outcome.transcript, "reply": outcome.reply, "tools": outcome.tools}


# The session id pattern, exported for the test that pins the wire contract.
SESSION_ID_RE = re.compile(SESSION_ID_PATTERN)
