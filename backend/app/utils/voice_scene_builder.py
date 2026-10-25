"""The scene AI as a sub-turn of the voice chat (docs/voice-chat.md "Scenes
written by voice"): `create_scene` and `change_scene` hand a spoken request
to the chat's scene-building loop and get one scene back, checked.

The sub-turn is the AI chat's own agent loop (app/utils/ai_chat_agent.py)
with the chat's system prompt (the scene guide included) and the EDITOR
tools alone — create_scenes, update_scene, patch_scene, edit_app_source,
render_scene — plus in-process `apps_list` / `app_source_get` for the app
catalog. Never the MCP server's tools: the caller is a frame's own
credential, not the owner's (docs/voice-chat.md). What the model "delivers
to the editor" is captured here instead, then rendered once more in the
frame's memory at the frame's size: a scene with runtime errors or one that
runs the frame out of memory goes back to the model as the browser's
`[Automatic render check]` would (docs/ai-chat.md), twice at most, and only
a scene that draws is handed back for the preview push. Without a renderer
on this backend (no Node or wasm build) the check is skipped, as the chat's
install check is.

The cloud's twin is cloud/apps/auth-web/src/lib/ai/voice-scene-builder.ts."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from app.models.apps import get_app_configs, get_one_app_sources
from app.models.frame import Frame
from app.utils.ai_chat_agent import AgentResult, ToolOutput, assistant_message, build_initial_input, run_agent_loop, user_message
from app.utils.ai_chat_prompt import build_chat_system_prompt
from app.utils.ai_chat_tools import (
    RENDER_OUT_OF_MEMORY_NOTE,
    BackendChatTools,
    RenderedScene,
    is_render_error_line,
    rgba_to_png,
)
from app.utils.device_limits import describe_out_of_memory, frame_render_device
from app.utils.repo_apps import REPO_APP_PREFIX, repo_app_configs, repo_app_sources

__all__ = [
    "MAX_BUILDER_ROUNDS",
    "MAX_RENDER_CHECKS",
    "SCENE_BUILDER_TIMEOUT_SECONDS",
    "SceneBuilderTools",
    "build_scene_by_voice",
    "render_check_message",
]

JsonObject = dict[str, Any]

# The frame waits three minutes for the answer (VOICE_DONE_TIMEOUT_MS); the
# transcription and the voice turn's own rounds take some of it.
SCENE_BUILDER_TIMEOUT_SECONDS = 100.0
MAX_BUILDER_ROUNDS = 10
# The browser's render check runs twice per message at most; so does this one.
MAX_RENDER_CHECKS = 2
DEFAULT_RENDER_SIZE = (800, 480)

# The catalog tools the backend's chat prompt names, answered from the
# in-process catalog (the same data /api/apps serves) since this turn has no
# session to call the route with. The descriptions are the MCP server's.
CATALOG_TOOL_DEFINITIONS: list[JsonObject] = [
    {
        "type": "function",
        "name": "apps_list",
        "description": (
            "The app catalog a scene's nodes come from: keyword (what a node's data.keyword names), name, category, "
            "description, fields with their types and defaults, output type. `search` filters by any of those. "
            "repo/apps/<folder>/<name> rows are JavaScript app templates: a scene copies one into its own `apps` map "
            "under <name> (app_source_get has its files)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"search": {"type": "string"}},
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "app_source_get",
        "description": (
            "The source files of one catalog app (config.json plus its Nim or JavaScript), for understanding what it "
            "does, building a code node after it, or copying a repo/apps/<folder>/<name> template into a scene."
        ),
        "parameters": {
            "type": "object",
            "properties": {"keyword": {"type": "string", "minLength": 1}},
            "required": ["keyword"],
            "additionalProperties": False,
        },
    },
]
CATALOG_TOOL_LABELS = {"apps_list": "Listing apps", "app_source_get": "Reading app source"}
MAX_CATALOG_RESULT_CHARS = 60_000


def _catalog_entries(search: str | None) -> list[JsonObject]:
    apps: list[JsonObject] = []
    for keyword, config in {**get_app_configs(), **repo_app_configs()}.items():
        if not isinstance(config, dict):
            continue
        entry = {
            "keyword": keyword,
            "name": config.get("name"),
            "category": config.get("category"),
            "description": config.get("description"),
            "fields": [
                {key: f.get(key) for key in ("name", "type", "label", "required", "value", "options") if key in f}
                for f in (config.get("fields") or [])
                if isinstance(f, dict)
            ],
            "output": config.get("output"),
        }
        if search:
            haystack = " ".join(str(v) for v in (keyword, entry["name"], entry["category"], entry["description"])).lower()
            if search.lower() not in haystack:
                continue
        apps.append(entry)
    return apps


class SceneBuilderTools(BackendChatTools):
    """The chat's editor tools without the MCP server, plus the two catalog
    tools: what a scene-building turn needs and nothing a frame's credential
    may not do."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(mcp=None, **kwargs)

    def definitions(self) -> list[JsonObject]:
        return [*super().definitions(), *CATALOG_TOOL_DEFINITIONS]

    def label(self, name: str) -> str:
        return CATALOG_TOOL_LABELS.get(name) or super().label(name)

    async def call(self, name: str, args: JsonObject) -> ToolOutput:
        if name == "apps_list":
            search = args.get("search") if isinstance(args.get("search"), str) else None
            apps = _catalog_entries(search)
            return ToolOutput(text=json.dumps({"apps": apps, "count": len(apps)})[:MAX_CATALOG_RESULT_CHARS])
        if name == "app_source_get":
            keyword = str(args.get("keyword") or "")
            sources = repo_app_sources(keyword) if keyword.startswith(REPO_APP_PREFIX) else get_one_app_sources(keyword)
            if not sources:
                return ToolOutput(text=json.dumps({"ok": False, "error": f"Unknown app keyword '{keyword}'. apps_list lists them."}))
            return ToolOutput(text=json.dumps(sources)[:MAX_CATALOG_RESULT_CHARS])
        return await super().call(name, args)


def _known_keywords() -> set[str]:
    return set(get_app_configs().keys()) | set(repo_app_configs().keys())


def render_size_for(frame: Frame) -> tuple[int, int]:
    if frame.width and frame.height:
        return (frame.height, frame.width) if frame.rotate in (90, 270) else (frame.width, frame.height)
    return DEFAULT_RENDER_SIZE


@dataclass
class RenderCheck:
    """What the final render of the delivered scene found: nothing (ok), the
    runtime's error lines, or the device's refused allocation."""

    ok: bool
    errors: list[str]
    out_of_memory: bool = False
    skipped: bool = False


def render_check_message(check: RenderCheck) -> str:
    """The follow-up the model gets when its scene did not draw: the same
    opening as the browser's automatic render check (chatLogic), so the
    prompt's rules for it apply."""
    if check.out_of_memory:
        return (
            "[Automatic render check] The scene was rendered in the frame's memory and ran out: "
            + "; ".join(check.errors)
            + "\n"
            + RENDER_OUT_OF_MEMORY_NOTE
            + " Deliver the corrected scene again."
        )
    return (
        "[Automatic render check] The scene was rendered on the frame's runtime and reported these errors:\n"
        + "\n".join(f"- {line}" for line in check.errors)
        + "\nFix them and deliver the complete corrected scene again (update_scene or patch_scene)."
    )


Render = Callable[[list[JsonObject], str | None, int, int], Awaitable[RenderedScene]]


def backend_renderer(frame: Frame) -> Render | None:
    """The chat route's render_scene for this frame: in the frame's memory on
    an ESP32 that renders locally. None when this backend cannot render."""
    from app.utils.embedded_render import render_scene, thin_client_renderer_available

    if not thin_client_renderer_available():
        return None
    device = frame_render_device(frame)

    async def render(scenes: list[JsonObject], scene_id: str | None, width: int, height: int) -> RenderedScene:
        limits = device.limits(width, height) if device else None
        result = await render_scene(frame, width, height, scene_id=scene_id, scenes_override=scenes, device_limits=limits)
        rendered_in = f"the frame's memory: {device.label}" if device else None
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
                f"The scene failed to render ({result.error or 'the runtime reported an error'}).",
                rendered_in,
                logs=result.scene_logs,
            )
        return RenderedScene(rgba_to_png(result.rgba, width, height), None, rendered_in, logs=result.scene_logs)

    return render


async def _check(render: Render | None, scenes: list[JsonObject], scene_id: str, size: tuple[int, int]) -> RenderCheck:
    if render is None:
        return RenderCheck(ok=True, errors=[], skipped=True)
    rendered = await render(scenes, scene_id, *size)
    if rendered.png is None:
        return RenderCheck(ok=False, errors=[rendered.error or "the runtime reported an error"], out_of_memory=rendered.out_of_memory)
    errors = [line for line in rendered.logs if is_render_error_line(line)]
    return RenderCheck(ok=not errors, errors=errors[:20])


def builder_context(frame_context: str, request: str, base: JsonObject | None, name: str | None) -> str:
    """The sub-turn's context: the frame, what was asked by voice, and the
    rules of this turn (what the tools are, where the scene goes)."""
    lines = [frame_context, ""]
    if base is not None:
        lines.append(
            "The user asked, by voice, for a change to the scene the frame shows. The scene is below; change it as "
            "asked with patch_scene / edit_app_source (small changes) or update_scene (most of it changes), keeping "
            "everything not mentioned. The changed scene goes on the frame as a preview; the user's installed scene "
            "is not touched."
        )
        lines.append(f"The spoken request: {request}")
        lines.append("The scene the frame shows:")
        lines.append(json.dumps(base))
    else:
        lines.append(
            "The user asked, by voice, for a new scene for this frame. Build it with create_scenes: one scene, fit "
            "for the frame's size and colors, that renders without the account's service keys unless the request "
            "needs an app that takes one."
        )
        lines.append(f"The spoken request: {request}")
        if name:
            lines.append(f"Name the scene: {name}")
    lines.append(
        "This turn has the editor tools (create_scenes, update_scene, patch_scene, edit_app_source, render_scene) and "
        "the catalog tools (apps_list, app_source_get) and no others: nothing here saves, installs or touches a frame; "
        "the scene you deliver is shown on the frame as a preview by the caller. Deliver, render it once with "
        "render_scene to check it, fix what is wrong, and end with one sentence saying what the scene shows. Nobody "
        "reads a question back: decide and build."
    )
    return "\n".join(lines)


async def build_scene_by_voice(
    *,
    frame: Frame,
    frame_context: str,
    request: str,
    base: JsonObject | None,
    name: str | None,
    api_key: str,
    model: str,
    reasoning_effort: str | None,
    http_client: httpx.AsyncClient | None = None,
    render: Render | None = None,
    timeout: float = SCENE_BUILDER_TIMEOUT_SECONDS,
    split_state_nodes: Callable[[JsonObject], None] | None = None,
) -> dict[str, Any]:
    """One scene for a spoken request: {"ok": True, "scene", "summary",
    "rounds", "render_checked"} or {"ok": False, "error", "detail"}. `base`
    is the scene to change (change_scene), None to build (create_scene).
    `render` defaults to this backend's renderer; None when it has none, and
    the check is skipped."""
    if render is None:
        render = backend_renderer(frame)
    size = render_size_for(frame)
    delivered: list[JsonObject] = []

    async def emit_scenes(event: JsonObject) -> None:
        scenes = event.get("scenes")
        if isinstance(scenes, list) and scenes and isinstance(scenes[0], dict):
            delivered[:] = [scenes[0]]

    # `base` keeps its id: the preview is replaced in place; an installed
    # scene arrives here as a copy under a new id (VoiceTools.change_scene),
    # since a preview whose id a saved scene holds would read as "installed"
    # (docs/scene-previews.md) and the voice chat never overwrites one.
    working = dict(base) if base is not None else None
    tools = SceneBuilderTools(
        project_id=int(frame.project_id),
        emit_scenes=emit_scenes,
        known_keywords=_known_keywords(),
        render_scene=render,
        current_scene=working,
        render_size=size,
        split_state_nodes=split_state_nodes,
        editor_available=True,
    )

    async def emit(event: dict[str, Any]) -> None:
        return None

    input_items = build_initial_input(builder_context(frame_context, request, working, name), [], request)

    async def run_once() -> AgentResult:
        return await run_agent_loop(
            api_key=api_key,
            model=model,
            reasoning_effort=reasoning_effort,
            instructions=build_chat_system_prompt(),
            input_items=input_items,
            tools=tools,
            emit=emit,
            http_client=http_client,
            max_rounds=MAX_BUILDER_ROUNDS,
        )

    async def build() -> dict[str, Any]:
        result = await run_once()
        checks = 0
        while True:
            if not delivered:
                return {"ok": False, "error": "no_scene", "detail": (result.reply.strip() or "the scene AI delivered no scene")[:500]}
            scene = delivered[0]
            check = await _check(render, [scene], str(scene.get("id")), size)
            if check.ok or checks >= MAX_RENDER_CHECKS:
                if not check.ok:
                    return {
                        "ok": False,
                        "error": "render_out_of_memory" if check.out_of_memory else "render_failed",
                        "detail": "; ".join(check.errors)[:500],
                        "rounds": result.rounds,
                    }
                return {
                    "ok": True,
                    "scene": scene,
                    "summary": result.reply.strip()[:500],
                    "rounds": result.rounds,
                    "render_checked": not check.skipped,
                }
            checks += 1
            # The scene it delivered is now the one to fix: update_scene and
            # patch_scene edit it (the editor would hold it by now).
            tools.current_scene = scene
            tools.current_scene_id = scene.get("id") if isinstance(scene.get("id"), str) else None
            # The browser's automatic render check, server-side: the model's
            # reply stays in the input, the errors follow as a user message.
            if result.reply.strip():
                input_items.append(assistant_message(result.reply.strip()))
            input_items.append(user_message(render_check_message(check)))
            result = await run_once()

    try:
        return await asyncio.wait_for(build(), timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timeout", "detail": f"the scene AI did not finish within {int(timeout)} seconds"}
