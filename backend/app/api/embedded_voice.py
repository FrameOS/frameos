"""`POST /api/frames/{id}/embedded/voice/{session}?seq=N&done=0|1`: an ESP32
frame streams what its user says while they hold the voice key, this answers
with the AI chat (docs/voice-chat.md).

Every chunk is raw 16 kHz 16-bit mono PCM; `seq` counts them from 0 and the
one with `done=1` (possibly empty) closes the session. Chunks sit in this
process's memory until then (app/utils/voice_chat.py VoiceSessionStore). The
closing request answers when the turn is over: the transcript, the reply and
the tools that ran, or `{"ok": false, "error": …}` for what the frame should
sound as an error. The frame's bearer is its `server_api_key`, as on every
other `/embedded` route; the tools the turn gets are the frame-scoped ones
(VoiceTools), narrowed by the owner's four permission switches in the
frame's device_config (VoicePermissions), never the account's MCP tools.

The exchanges are one chat per frame (the frame's voice chat in the workspace's
chat drawer): what was heard, a `log` row with every tool the turn ran and
what came of it, and the reply. The next turn gets the last few exchanges as
history, each with how long ago it was and its actions, so "make it bigger"
has the scene the previous turn built to refer to (voice_history_for_model).
`create_scene` and `change_scene` run the scene AI as a sub-turn
(app/utils/voice_scene_builder.py) and push what it built as a preview.

The cloud's twin is cloud/apps/auth-web/app/api/frames/[frameId]/voice/[sessionId]/route.ts."""
from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
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
from app.models.photo_share import PhotoShare
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.models.frame import update_frame
from app.utils.ai_scene import CHAT_MODEL, openai_model
from app.utils.embedded_commands import nudge_embedded_frame, queue_embedded_command, queue_embedded_scene_preview
from app.utils import photos
from app.utils.frame_commands import enqueue_frame_command
from app.utils.photo_album_scene import DEFAULT_SECONDS, build_photo_album_scene
from app.utils.rate_limit import hit_rate_limit
from app.utils.upload_limits import read_body_limited
from app.utils.frame_commands import scene_preview_info, scene_preview_scene
from app.utils.voice_chat import (
    MAX_VOICE_HISTORY_TURNS,
    VOICE_BYTES_PER_SECOND,
    VOICE_LOG_TOOL,
    VOICE_MAX_CHUNK_BYTES,
    VOICE_SESSIONS_PER_FRAME_PER_15_MIN,
    VOICE_TURN_TOOL,
    VoicePermissions,
    VoiceSessionStore,
    VoiceTools,
    VoiceTurnResult,
    image_sources_for_settings,
    transcribe_and_answer,
    voice_chat_id,
    voice_frame_context,
    voice_history_for_model,
    voice_turn_log,
)
from app.utils.voice_scene_builder import build_scene_by_voice
from . import api_public

__all__ = ["api_embedded_device_voice"]

SESSION_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"
# Under this much audio nobody said anything the transcription could hear;
# saying so costs no OpenAI call.
MIN_AUDIO_SECONDS = 0.3
# A scene switch waits this long for the awake frame's ack, as the event route does.
COMMAND_WAIT_SECONDS = 4.0
# Three rows per exchange (heard, log, reply), a few more for the workspace's own.
MAX_HISTORY_ROWS = 4 * MAX_VOICE_HISTORY_TURNS

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


def _history(db: Session, chat: Chat, now: datetime) -> list[dict[str, str]]:
    """The earlier exchanges for the model: transcript, reply and the turn's
    actions with its age (voice_history_for_model), oldest first."""
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.project_id == chat.project_id, ChatMessage.chat_id == chat.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(MAX_HISTORY_ROWS)
        .all()
    )
    rows = [
        {"role": m.role, "content": m.content, "tool": m.tool, "created_at": m.created_at}
        for m in reversed(messages)
    ]
    return voice_history_for_model(rows, now=now)


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

    started = time.monotonic()
    now = datetime.now(timezone.utc)
    # The scene the frame shows for now without holding it (the editor's or
    # an earlier turn's preview): the model is told, and change_scene edits it.
    preview_info = scene_preview_info(db, frame)
    preview_scene = scene_preview_scene(db, frame) if preview_info else None
    active_scene_id = await _active_scene_id(
        redis, frame, [*(frame.scenes or []), *([preview_scene] if preview_scene else [])]
    )
    chat = _voice_chat(db, frame)
    history = _history(db, chat, now)
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

    async def list_albums() -> dict[str, Any]:
        # The photo library's root (docs/photos.md): the albums, as the
        # Photos page lists them. A library that is not set up says so.
        try:
            await asyncio.to_thread(photos.ready_store)
            listing = await asyncio.to_thread(photos.list_folder, db, int(frame.project_id), "")
        except HTTPException as error:
            return {"ok": False, "error": "photos_unavailable", "detail": str(error.detail)[:300]}
        return {
            "albums": [
                {"path": entry["path"], "name": entry.get("name"), "photos": entry.get("items", 0)}
                for entry in listing["entries"]
                if entry.get("kind") == "folder"
            ]
        }

    async def install_album(path: str, options: dict[str, Any]) -> dict[str, Any]:
        # What the MCP's photo_album_install does for this frame (docs/photos.md
        # "Installing photo scenes"): the frame's own share link to the folder
        # (made now if it has none), the album scene saved next to the frame's
        # scenes, a fast deploy (the device pulls the saved scenes) and the
        # switch to it, as the Settings' set_next_scene route queues them.
        from app.api.photos import _frame_origin
        from app.tasks import fast_deploy_frame
        from app.tasks.utils import begin_deploy_progress, deploy_progress_kind_for_frame

        project_id = int(frame.project_id)
        try:
            rel = photos.validate_path(path)
            await asyncio.to_thread(photos.ready_store)
            await asyncio.to_thread(photos.assert_shareable_folder, db, project_id, rel)
            origin = _frame_origin(frame)
        except HTTPException as error:
            return {"ok": False, "status": "failed", "error": "album_unavailable", "detail": str(error.detail)[:300]}
        share = (
            db.query(PhotoShare)
            .filter(
                PhotoShare.project_id == project_id,
                PhotoShare.path == rel,
                PhotoShare.frame_id == int(frame.id),
                PhotoShare.name.is_(None),
            )
            .order_by(PhotoShare.id.asc())
            .first()
        )
        if share is None:
            share = PhotoShare(project_id=project_id, path=rel, frame_id=int(frame.id), token=f"pk_{secrets.token_urlsafe(32)}")
            db.add(share)
            db.commit()
            db.refresh(share)
        scene = build_photo_album_scene(
            name=photos.base_name(rel),
            album_url=origin + photos.share_url(share.token),
            seconds=options.get("seconds", DEFAULT_SECONDS),
            order=options.get("order", "random"),
            fit="cover",
            shapes=list(photos.SHARE_SHAPES),
        )
        saved = [existing for existing in (frame.scenes or []) if isinstance(existing, dict)]
        frame.scenes = [*saved, scene]
        db.add(frame)
        db.commit()
        await update_frame(db, redis, frame)
        await new_log(db, redis, int(frame.id), "stdinfo", f"Voice chat installed the album {rel}")
        await begin_deploy_progress(db, redis, frame, deploy_progress_kind_for_frame(frame, "fast"))
        await fast_deploy_frame(int(frame.id), redis)
        outcome = await queue_command("set_current_scene", {"scene_id": scene["id"]})
        return {"scene": scene["name"], "scene_id": scene["id"], "album": rel, **outcome}

    model = openai_model(openai_settings, "chatModel", CHAT_MODEL)
    reasoning_effort = openai_settings.get("chatReasoningEffort") or None

    async def build_scene(request: str, base: dict[str, Any] | None, name: str | None) -> dict[str, Any]:
        # The scene AI as a sub-turn (voice_scene_builder.py): the editor
        # tools alone, the scene rendered in the frame's memory before it is
        # handed back; the tool then pushes it as the preview above.
        from app.api.ai_scenes import _split_state_nodes_by_app

        what = f"changes {base.get('name')}" if base else "builds a scene"
        await new_log(db, redis, int(frame.id), "stdinfo", f"Voice chat {what}: {request[:200]}")
        return await build_scene_by_voice(
            frame=frame,
            frame_context=frame_context_block(frame),
            request=request,
            base=base,
            name=name,
            api_key=api_key.strip(),
            model=model,
            reasoning_effort=reasoning_effort,
            split_state_nodes=_split_state_nodes_by_app,
        )

    image_sources = image_sources_for_settings(settings)
    # The owner's switches (Settings -> Voice chat): a tool they turned off is
    # not offered to the model, and refused if named anyway.
    permissions = VoicePermissions.from_frame(frame)
    tools = VoiceTools(
        frame=frame,
        active_scene_id=active_scene_id,
        queue_command=queue_command,
        preview_scenes=preview_scenes,
        update_settings=update_settings,
        image_sources=image_sources,
        permissions=permissions,
        list_albums=list_albums,
        install_album=install_album,
        build_scene=build_scene,
        preview_scene=preview_scene,
    )
    outcome = await transcribe_and_answer(
        pcm=pcm,
        api_key=api_key.strip(),
        model=model,
        reasoning_effort=reasoning_effort,
        scene_names=scene_names,
        context_block=voice_frame_context(
            frame, active_scene_id, frame_context_block(frame), image_sources, permissions, preview=preview_info, now=now
        ),
        history=history,
        tools=tools,
    )
    if not isinstance(outcome, VoiceTurnResult):
        error, detail = outcome
        await new_log(db, redis, int(frame.id), "stderr", f"Voice chat failed ({error}): {detail[:300]}")
        return _failure(error, detail)

    # The exchange, three rows in one commit: what was heard, the log of what
    # was done (the workspace draws it as a log bubble; the next turn reads it
    # as history), the reply. A millisecond apart keeps them in order on a
    # database whose default timestamp is the whole second.
    stored_at = datetime.utcnow()
    chat.updated_at = stored_at
    db.add(ChatMessage(project_id=chat.project_id, chat_id=chat.id, role="user", content=outcome.transcript,
                       tool=VOICE_TURN_TOOL, created_at=stored_at))
    db.add(ChatMessage(
        project_id=chat.project_id,
        chat_id=chat.id,
        role="assistant",
        content=voice_turn_log(outcome.actions, session_id=session_id, seconds=time.monotonic() - started, at=stored_at),
        tool=VOICE_LOG_TOOL,
        created_at=stored_at + timedelta(milliseconds=1),
    ))
    db.add(ChatMessage(project_id=chat.project_id, chat_id=chat.id, role="assistant", content=outcome.reply,
                       tool=VOICE_TURN_TOOL, created_at=stored_at + timedelta(milliseconds=2)))
    db.commit()
    await new_log(
        db,
        redis,
        int(frame.id),
        "stdinfo",
        json.dumps({"event": "voice:turn", "transcript": outcome.transcript[:300], "reply": outcome.reply[:300],
                    "tools": outcome.tools, "seconds": round(time.monotonic() - started, 1)}),
    )
    return {"ok": True, "transcript": outcome.transcript, "reply": outcome.reply, "tools": outcome.tools}


# The session id pattern, exported for the test that pins the wire contract.
SESSION_ID_RE = re.compile(SESSION_ID_PATTERN)
