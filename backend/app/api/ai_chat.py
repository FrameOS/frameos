"""`POST /api/projects/{id}/ai/chat`: the AI chat (docs/ai-chat.md).

One streaming agent loop over the OpenAI Responses API (app/utils/ai_chat_agent.py)
with every MCP tool of this backend plus the editor tools
(app/utils/ai_chat_tools.py). The response is NDJSON, one event per line — the
same events the cloud's /api/ai/chat sends, read by the same chatLogic in the
SPA: chat, delta, tool, scenes, done, error, ping.

The turn runs as its own task: a browser that drops the stream does not stop
it, and its reply is still stored on the chat. Unlike the cloud there is no
resume endpoint; the chat shows the reply when it is reopened."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from http import HTTPStatus
from typing import Any, AsyncIterator, Optional

from fastapi import Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.ai_scenes import _split_state_nodes_by_app
from app.api.auth import request_api_token
from app.database import get_db
from app.mcp.server import build_server
from app.models.apps import get_app_configs
from app.models.chat import Chat, ChatMessage, find_project_chat, project_chat_id
from app.models.frame import Frame
from app.models.settings import get_settings_dict
from app.tenancy import current_project_id
from app.utils.ai_chat_agent import OpenAiRequestError, build_initial_input, run_agent_loop
from app.utils.ai_chat_prompt import build_chat_system_prompt
from app.utils.ai_chat_tools import (
    INSTALL_OUT_OF_MEMORY_NOTE,
    BackendChatTools,
    RenderedScene,
    rgba_to_png,
    untrusted_result,
)
from app.utils.device_limits import describe_out_of_memory, frame_render_device
from app.utils.ai_scene import CHAT_MODEL, openai_model
from app.utils.public_origin import public_origin
from app.utils.repo_apps import repo_app_configs
from app.utils.request_ip import client_ip_for_request
from . import api_project

__all__ = ["ai_chat_turn", "frame_context_block"]

MAX_PROMPT_CHARS = 20_000
MAX_SCENE_CONTEXT_CHARS = 300_000
MAX_HISTORY_MESSAGES = 16
PING_INTERVAL_SECONDS = 15.0
FORWARDED_HEADERS = ("authorization", "cookie")

# Turns that outlived their stream, kept referenced until they finish.
_running_turns: set[asyncio.Task] = set()


class AiChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prompt: str
    chat_id: Optional[str] = Field(default=None, alias="chatId")
    frame_id: Optional[int] = Field(default=None, alias="frameId")
    scene_id: Optional[str] = Field(default=None, alias="sceneId")
    scene: Optional[dict[str, Any]] = None
    selected_nodes: Optional[list[dict[str, Any]]] = Field(default=None, alias="selectedNodes")
    selected_edges: Optional[list[dict[str, Any]]] = Field(default=None, alias="selectedEdges")
    history: Optional[list[dict[str, Any]]] = None
    render_size: Optional[dict[str, Any]] = Field(default=None, alias="renderSize")
    time_zone: Optional[str] = Field(default=None, alias="timeZone")
    # False from the frames home's AI box: no editor to deliver scenes into.
    editor: Optional[bool] = None


def frame_context_block(frame: Frame) -> str:
    """The frame the chat is about, for the model's first message. The voice
    chat (app/api/embedded_voice.py) sends the same block."""
    lines = ["The user is working with this frame:", f"- Frame id: {frame.id}", f"- Name: {frame.name}"]
    if frame.width and frame.height:
        lines.append(f"- Resolution: {frame.width}x{frame.height}" + (f", rotated {frame.rotate}°" if frame.rotate else ""))
    if frame.device:
        lines.append(f"- Display driver (device): {frame.device}")
    if frame.color:
        lines.append(f"- Color mode: {frame.color}")
    if frame.mode:
        lines.append(f"- Frame type: {frame.mode}")
    render_device = frame_render_device(frame)
    if render_device:
        lines.append(
            f"- Memory: {render_device.label}. A scene that needs more aborts on the frame; "
            "render_scene renders in the same memory."
        )
    lines.append(f"- Status: {frame.status}")
    scenes = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    if scenes:
        # Scene names may come from the catalog or anyone's upload.
        listing = ", ".join(
            f"{scene.get('name') or 'Untitled'} ({scene.get('id')}){' [default]' if scene.get('default') else ''}"
            for scene in scenes
        )
        lines.append("- Installed scenes: " + untrusted_result("installed_scene_names", listing))
    else:
        lines.append("- No scenes installed yet.")
    return "\n".join(lines)


def _scene_context(scene: dict[str, Any], selected_nodes: list[dict[str, Any]], selected_edges: list[dict[str, Any]]) -> str:
    lines = [
        f"The user has this scene open in the editor (id {scene.get('id')}). update_scene / patch_scene / "
        "edit_app_source change it; render_scene shows it.",
        untrusted_result("open_scene", json.dumps(scene)),
    ]
    if selected_nodes or selected_edges:
        lines.append("The user selected these parts of it (\"this\", \"these\" in their message refer to them):")
        lines.append(untrusted_result("selection", json.dumps({"nodes": selected_nodes, "edges": selected_edges})))
    return "\n".join(lines)


def _known_keywords() -> set[str]:
    return set(get_app_configs().keys()) | set(repo_app_configs().keys())


def _render_size(value: Optional[dict[str, Any]], frame: Frame | None) -> tuple[int, int] | None:
    if isinstance(value, dict):
        width, height = value.get("width"), value.get("height")
        if isinstance(width, int) and isinstance(height, int) and 16 <= width <= 4096 and 16 <= height <= 4096:
            return width, height
    if frame and frame.width and frame.height:
        if frame.rotate in (90, 270):
            return frame.height, frame.width
        return frame.width, frame.height
    return None


def _history_from_db(db: Session, chat: Chat, project_id: int) -> list[dict[str, str]]:
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.project_id == project_id, ChatMessage.chat_id == chat.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(MAX_HISTORY_MESSAGES)
        .all()
    )
    return [
        {"role": message.role, "content": message.content}
        for message in reversed(messages)
        if message.role in ("user", "assistant") and message.content and message.tool != "error"
    ]


@api_project.post("/ai/chat")
async def ai_chat_turn(data: AiChatRequest, request: Request, db: Session = Depends(get_db)):
    project_id = current_project_id()
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Prompt is required")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST, detail=f"A message can be at most {MAX_PROMPT_CHARS} characters."
        )
    settings = get_settings_dict(db, project_id=project_id)
    openai_settings = settings.get("openAI") or {}
    api_key = openai_settings.get("backendApiKey")
    if not isinstance(api_key, str) or not api_key.strip():
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Add an OpenAI API key for the backend in Settings → OpenAI to use the AI chat.",
        )
    model = openai_model(openai_settings, "chatModel", CHAT_MODEL)
    reasoning_effort = openai_settings.get("chatReasoningEffort") or None

    frame: Frame | None = None
    if data.frame_id is not None:
        frame = db.query(Frame).filter(Frame.project_id == project_id, Frame.id == data.frame_id).first()
        if frame is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    scene = data.scene if isinstance(data.scene, dict) else None
    if scene is not None and len(json.dumps(scene)) > MAX_SCENE_CONTEXT_CHARS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="This scene is too large for the AI chat.")

    chat = find_project_chat(db, project_id, data.chat_id)
    if chat is not None and data.frame_id is not None and chat.frame_id not in (None, data.frame_id):
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Chat does not belong to frame")
    history = _history_from_db(db, chat, project_id) if chat is not None else [
        {"role": str(entry.get("role")), "content": str(entry.get("content") or "")}
        for entry in (data.history or [])[-MAX_HISTORY_MESSAGES:]
        if entry.get("role") in ("user", "assistant")
    ]
    if chat is None:
        chat = Chat(
            **({"id": project_chat_id(project_id, data.chat_id)} if data.chat_id else {}),
            project_id=project_id,
            frame_id=data.frame_id,
            scene_id=data.scene_id,
            context_type="scene" if data.scene_id else "frame",
            context_id=data.scene_id,
        )
        db.add(chat)
        db.flush()
    elif data.scene_id and chat.context_type in (None, "scene", "frame"):
        chat.scene_id = data.scene_id
        chat.context_type = "scene"
        chat.context_id = data.scene_id
    chat.updated_at = datetime.utcnow()
    db.add(ChatMessage(project_id=project_id, chat_id=chat.id, role="user", content=prompt))
    db.commit()
    chat_id = chat.id

    context_parts = []
    if frame is not None:
        context_parts.append(frame_context_block(frame))
    else:
        context_parts.append(
            "The user opened this chat from the frames overview, not from one frame, and has no scene editor open. "
            "Find the frame they mean with frames_list when the request is about one."
        )
    if scene is not None:
        context_parts.append(_scene_context(scene, data.selected_nodes or [], data.selected_edges or []))
    if data.time_zone:
        context_parts.append(f"The user's time zone: {data.time_zone[:64]}")
    input_items = build_initial_input("\n\n".join(context_parts), history, prompt)

    token = request_api_token(request)
    auth = (
        {"kind": "api_token", "token_name": token.name, "token_access": token.access}
        if token
        else {"kind": "session", "token_access": "full"}
    )
    headers = {name: value for name, value in request.headers.items() if name.lower() in FORWARDED_HEADERS}
    mcp, api = build_server(
        app=request.app,
        headers=headers,
        client_ip=client_ip_for_request(request) or "127.0.0.1",
        public_origin=public_origin(request),
        auth=auth,
    )

    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def emit(event: dict[str, Any]) -> None:
        await queue.put(event)

    render_frame = frame or Frame(id=0, name="Preview", timezone=data.time_zone, network={})
    # An ESP32 renders in a few megabytes: render_scene renders in as much, so
    # a scene that would run the frame out of memory fails here first.
    render_device = frame_render_device(frame)

    async def render(scenes: list[dict[str, Any]], scene_id: str | None, width: int, height: int) -> RenderedScene:
        from app.utils.embedded_render import render_scene, thin_client_renderer_available

        if not thin_client_renderer_available():
            return RenderedScene(
                None, "The scene renderer is not available on this backend (Node.js or the wasm runtime is missing)."
            )
        limits = render_device.limits(width, height) if render_device else None
        result = await render_scene(
            render_frame, width, height, scene_id=scene_id, scenes_override=scenes, device_limits=limits
        )
        rendered_in = f"the frame's memory: {render_device.label}" if render_device else None
        if result.rgba is None:
            if result.out_of_memory and limits:
                error = describe_out_of_memory(
                    int(result.out_of_memory.get("refusedBytes") or 0),
                    int(result.out_of_memory.get("usedBytes") or 0),
                    limits,
                )
                return RenderedScene(None, error, rendered_in, out_of_memory=True, logs=result.scene_logs)
            return RenderedScene(
                None,
                f"The scene failed to render ({result.error or 'the runtime reported an error'}). "
                "Check the scene's code nodes and app fields.",
                rendered_in,
                logs=result.scene_logs,
            )
        return RenderedScene(rgba_to_png(result.rgba, width, height), None, rendered_in, logs=result.scene_logs)

    async def check_install(name: str, args: dict[str, Any]) -> str | None:
        """Before frame_scene_install / frame_scene_update puts a scene on a frame
        that renders in a few megabytes, render it in that frame's memory: one
        that runs out is not installed. Only memory refuses; a source the tool
        will reject, or a render that fails some other way, goes through."""
        from app.mcp.client import ApiError
        from app.mcp.result import McpInputError
        from app.mcp.tools.frames import as_scene_list
        from app.utils.embedded_render import RenderQueueFull, render_scene, thin_client_renderer_available

        raw_frame_id = args.get("frame_id")
        target_id: int | None = None
        if isinstance(raw_frame_id, int):
            target_id = raw_frame_id
        elif isinstance(raw_frame_id, str) and raw_frame_id.isdigit():
            target_id = int(raw_frame_id)
        target = (
            db.query(Frame).filter(Frame.project_id == project_id, Frame.id == target_id).first()
            if target_id is not None
            else None
        )
        device = frame_render_device(target)
        if target is None or device is None or not thin_client_renderer_available():
            return None
        try:
            if name == "frame_scene_update":
                scenes = as_scene_list(args.get("scene"))
            elif args.get("scenes") is not None:
                scenes = as_scene_list(args.get("scenes"))
            elif isinstance(args.get("template_id"), str):
                payload = await api.json("GET", f"/api/templates/{args['template_id']}", project_id=project_id)
                scenes = as_scene_list(payload.get("scenes"))
            else:
                # A catalog template or a URL: a published scene, not one this chat wrote.
                return None
        except (McpInputError, ApiError):
            return None
        width, height = _render_size(None, target) or (800, 480)
        main = next((scene for scene in scenes if scene.get("default")), scenes[0])
        limits = device.limits(width, height)
        try:
            result = await render_scene(
                target, width, height, scene_id=main.get("id"), scenes_override=scenes, device_limits=limits
            )
        except RenderQueueFull:
            return None
        if not result.out_of_memory:
            return None
        return json.dumps({
            "ok": False,
            "installed": False,
            "error": describe_out_of_memory(
                int(result.out_of_memory.get("refusedBytes") or 0),
                int(result.out_of_memory.get("usedBytes") or 0),
                limits,
            ),
            "rendered_in": f"the frame's memory: {device.label}",
            "note": INSTALL_OUT_OF_MEMORY_NOTE,
        })

    editor_scenes = [s for s in (frame.scenes or []) if isinstance(s, dict)] if frame is not None else []
    tools = BackendChatTools(
        mcp=mcp,
        project_id=project_id,
        emit_scenes=emit,
        known_keywords=_known_keywords(),
        render_scene=render,
        current_scene=scene,
        editor_scenes=editor_scenes,
        render_size=_render_size(data.render_size, frame),
        split_state_nodes=_split_state_nodes_by_app,
        editor_available=frame is not None and data.editor is not False,
        check_install=check_install,
    )

    def record(content: str, tool: str) -> None:
        stored = find_project_chat(db, project_id, chat_id)
        if stored is None:
            return
        stored.updated_at = datetime.utcnow()
        db.add(ChatMessage(project_id=project_id, chat_id=stored.id, role="assistant", content=content, tool=tool))
        db.commit()

    async def run_turn() -> None:
        # The stored id: the browser re-keys the chat it named to it.
        await emit({"type": "chat", "chatId": chat_id})
        try:
            result = await run_agent_loop(
                api_key=api_key.strip(),
                model=model,
                reasoning_effort=reasoning_effort,
                instructions=build_chat_system_prompt(),
                input_items=input_items,
                tools=tools,
                emit=emit,
            )
            record(result.reply or "Done.", result.tool)
            await emit({"type": "done", "tool": result.tool, "reply": result.reply})
        except Exception as error:  # noqa: BLE001 — the turn's failure is the user's to read
            detail = str(error) if isinstance(error, OpenAiRequestError) else f"AI chat failed: {error}"
            try:
                record(detail, "error")
            except Exception:  # noqa: BLE001
                pass
            await emit({"type": "error", "detail": detail})
        finally:
            await api.aclose()
            await queue.put(None)

    task = asyncio.create_task(run_turn())
    _running_turns.add(task)
    task.add_done_callback(_running_turns.discard)

    async def stream() -> AsyncIterator[bytes]:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                yield b'{"type":"ping"}\n'
                continue
            if event is None:
                return
            yield (json.dumps(event) + "\n").encode()

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
