"""The backend's scene AI (OpenAI, with the project's key from settings):
generate a scene from a prompt, chat about a scene, read past chats. The AI
never touches a frame: it answers with scene JSON, and installing it is a
separate, confirmed frame_scene_install."""
from __future__ import annotations

from typing import Any

from ..client import ToolContext
from ..protocol import McpServer
from ..registry import Tool
from ..result import run, text


def register_ai_tools(server: McpServer, ctx: ToolContext) -> None:
    api = ctx.api

    async def ai_scene_generate(prompt: str, frame_id: int | None = None, project_id: int | None = None):
        async def go():
            body: dict[str, Any] = {"prompt": prompt}
            if frame_id is not None:
                body["frameId"] = frame_id
            payload = await api.json("POST", "/api/ai/scenes/generate", project_id=project_id, json=body)
            scenes = payload.get("scenes") or []
            return text({
                "title": payload.get("title"),
                "scenes": scenes,
                "context_used": [
                    {key: item.get(key) for key in ("source_type", "source_path", "name")}
                    for item in (payload.get("context") or [])
                    if isinstance(item, dict)
                ],
                "next": "Review the scene JSON, then frame_scene_install(frame_id, scenes=…) or scene_create(name, scenes=…) to keep it.",
            })

        return await run(go)

    server.tool(Tool(
        name="ai_scene_generate",
        description=(
            "Ask the backend's scene AI to build a scene from a description (needs the project's OpenAI key, "
            "settings_get openAI). frame_id gives it the frame's size, device and colors. Returns scene JSON "
            "— nothing is installed; follow with frame_scene_install or scene_create."
        ),
        properties={
            "prompt": {"type": "string", "minLength": 1},
            "frame_id": {"type": "integer", "description": "Frame to build it for (size, device, palette)."},
        },
        required=["prompt"],
        handler=ai_scene_generate,
    ))

    async def ai_scene_chat(
        prompt: str,
        frame_id: int,
        scene_id: str | None = None,
        chat_id: str | None = None,
        scene: dict[str, Any] | None = None,
        project_id: int | None = None,
    ):
        async def go():
            body: dict[str, Any] = {"prompt": prompt, "frameId": frame_id}
            if scene_id:
                body["sceneId"] = scene_id
            if chat_id:
                body["chatId"] = chat_id
            if scene is not None:
                body["scene"] = scene
            elif scene_id:
                frame = (await api.json("GET", f"/api/frames/{frame_id}", project_id=project_id))["frame"]
                for candidate in frame.get("scenes") or []:
                    if isinstance(candidate, dict) and candidate.get("id") == scene_id:
                        body["scene"] = candidate
                        break
            payload = await api.json("POST", "/api/ai/scenes/chat", project_id=project_id, json=body)
            result = {
                "reply": payload.get("reply"),
                "tool": payload.get("tool"),
                "chat_id": payload.get("chatId"),
                "title": payload.get("title"),
                "scenes": payload.get("scenes"),
            }
            if payload.get("scenes"):
                result["next"] = (
                    "The AI proposes scene JSON; it is not applied. Install it with frame_scene_install "
                    "(a new scene) or frame_scene_update (the same id), only if the user wants it."
                )
            return text(result)

        return await run(go)

    server.tool(Tool(
        name="ai_scene_chat",
        description=(
            "Chat with the scene AI about a frame (frame_id) or one of its scenes (scene_id — its JSON is sent "
            "along unless you pass `scene`). Pass chat_id to continue a conversation. The reply may propose "
            "scene JSON; nothing is applied to the frame by this tool."
        ),
        properties={
            "prompt": {"type": "string", "minLength": 1},
            "frame_id": {"type": "integer"},
            "scene_id": {"type": "string"},
            "chat_id": {"type": "string"},
            "scene": {"type": "object", "description": "A scene to discuss instead of the installed copy (e.g. one being edited)."},
        },
        required=["prompt", "frame_id"],
        handler=ai_scene_chat,
    ))

    async def ai_chats_list(frame_id: int, limit: int = 20, offset: int = 0, project_id: int | None = None):
        return await run(lambda: _text(api, "GET", "/api/ai/chats", project_id, params={"frameId": frame_id, "limit": limit, "offset": offset}))

    server.tool(Tool(
        name="ai_chats_list",
        description="Past scene AI chats for a frame (id, title, scene, when), newest first.",
        properties={
            "frame_id": {"type": "integer"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            "offset": {"type": "integer", "minimum": 0},
        },
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=ai_chats_list,
    ))

    async def ai_chat_get(chat_id: str, project_id: int | None = None):
        return await run(lambda: _text(api, "GET", f"/api/ai/chats/{chat_id}", project_id))

    server.tool(Tool(
        name="ai_chat_get",
        description="One scene AI chat with all its messages.",
        properties={"chat_id": {"type": "string", "minLength": 1}},
        required=["chat_id"],
        annotations={"readOnlyHint": True},
        handler=ai_chat_get,
    ))


async def _text(api, method: str, path: str, project_id: int | None, **kwargs: Any):
    return text(await api.json(method, path, project_id=project_id, **kwargs))
