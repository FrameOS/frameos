from datetime import datetime
from http import HTTPStatus
from uuid import uuid4

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.chat import Chat, ChatMessage
from app.models.settings import get_settings_dict
from app.schemas.ai_apps import AiAppChatRequest, AiAppChatResponse
from app.utils.ai_app import answer_app_question, edit_app_sources, route_app_chat
from . import api_with_auth


def _build_app_context_id(scene_id: str | None, node_id: str | None) -> str | None:
    if not scene_id or not node_id:
        return None
    return f"{scene_id}::{node_id}"


@api_with_auth.post("/ai/apps/chat", response_model=AiAppChatResponse)
async def chat_app(
    data: AiAppChatRequest,
    db: Session = Depends(get_db),
):
    request_id = data.request_id or str(uuid4())
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Prompt is required")

    if not isinstance(data.sources, dict) or not data.sources:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="App sources are required")

    chat = None
    context_id = _build_app_context_id(data.scene_id, data.node_id)
    if data.frame_id is not None:
        if data.chat_id:
            chat = db.query(Chat).filter(Chat.id == data.chat_id).first()
            if chat and chat.frame_id != data.frame_id:
                raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Chat does not belong to frame")
            if chat and chat.context_type not in (None, "app"):
                raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Chat context does not match app chat")
        if not chat:
            if data.chat_id:
                chat = Chat(
                    id=data.chat_id,
                    frame_id=data.frame_id,
                    context_type="app",
                    context_id=context_id,
                )
            else:
                chat = Chat(
                    frame_id=data.frame_id,
                    context_type="app",
                    context_id=context_id,
                )
            db.add(chat)
            db.commit()
            db.refresh(chat)
        if context_id:
            chat.context_type = "app"
            chat.context_id = context_id
        if chat:
            chat.updated_at = datetime.utcnow()
            db.add(chat)
            db.add(ChatMessage(chat_id=chat.id, role="user", content=prompt))
            db.commit()

    def _record_assistant_message(reply: str, tool: str) -> None:
        if not chat:
            return
        chat.updated_at = datetime.utcnow()
        db.add(chat)
        db.add(ChatMessage(chat_id=chat.id, role="assistant", content=reply, tool=tool))
        db.commit()

    settings = get_settings_dict(db)
    openai_settings = settings.get("openAI", {})
    api_key = openai_settings.get("backendApiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI backend API key not set")

    history = [item.model_dump() for item in (data.history or [])]
    model = openai_settings.get("appChatModel") or openai_settings.get("chatModel") or "gpt-5-mini"

    tool_payload = {}
    tool = "ask_about_app"
    tool_prompt = prompt
    try:
        tool_payload = await route_app_chat(
            prompt=prompt,
            app_name=data.app_name,
            app_keyword=data.app_keyword,
            scene_id=data.scene_id,
            node_id=data.node_id,
            history=history,
            api_key=api_key,
            model=model,
            ai_trace_id=request_id,
            ai_session_id=None,
        )
        if isinstance(tool_payload, dict):
            tool = tool_payload.get("tool") or tool
            tool_prompt = tool_payload.get("tool_prompt") or prompt
    except Exception:
        tool = "ask_about_app"
        tool_prompt = prompt

    reply = ""
    files: dict[str, str] | None = None
    if tool == "edit_app":
        edit_payload = await edit_app_sources(
            prompt=tool_prompt,
            sources=data.sources,
            app_name=data.app_name,
            app_keyword=data.app_keyword,
            scene_id=data.scene_id,
            node_id=data.node_id,
            history=history,
            api_key=api_key,
            model=openai_settings.get("appEditModel") or openai_settings.get("chatModel") or "gpt-5-mini",
            ai_trace_id=request_id,
            ai_session_id=None,
        )
        if isinstance(edit_payload, dict):
            reply = edit_payload.get("reply") or "Updated app files."
            files_payload = edit_payload.get("files")
            if isinstance(files_payload, dict):
                files = {str(key): str(value) for key, value in files_payload.items()}
        if not reply:
            reply = "Updated app files."
    else:
        answer_payload = await answer_app_question(
            prompt=tool_prompt,
            sources=data.sources,
            app_name=data.app_name,
            app_keyword=data.app_keyword,
            scene_id=data.scene_id,
            node_id=data.node_id,
            history=history,
            api_key=api_key,
            model=openai_settings.get("appChatModel") or openai_settings.get("chatModel") or "gpt-5-mini",
            ai_trace_id=request_id,
            ai_session_id=None,
        )
        if isinstance(answer_payload, dict):
            reply = answer_payload.get("answer") or ""
        if not reply:
            reply = "Done."
        tool = "ask_about_app"

    _record_assistant_message(reply, tool)

    return AiAppChatResponse(reply=reply, tool=tool, chatId=chat.id if chat else None, files=files)
