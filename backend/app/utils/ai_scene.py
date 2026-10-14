import json
import re
from typing import Any, Iterable
from uuid import uuid4

from posthog.ai.openai import AsyncOpenAI
from posthog.client import Client as PostHogClient

from app.config import config
from app.utils.ai_catalog import AiCatalogItem
from app.utils.scene_guide_gen import SCENE_GUIDE
from app.utils.posthog import get_posthog_client, llm_analytics_enabled

SCENE_MODEL = "gpt-5.5"
CHAT_MODEL = "gpt-5.5"
SCENE_REVIEW_MODEL = "gpt-5.5"
AI_REQUEST_TIMEOUT = 600


def openai_model(settings: dict[str, Any], field: str, default: str) -> str:
    configured_model = settings.get(field)
    shared_model = settings.get("model")
    if isinstance(configured_model, str) and configured_model.strip():
        return configured_model.strip()
    if isinstance(shared_model, str) and shared_model.strip():
        return shared_model.strip()
    return default


def _format_gpio_buttons(gpio_buttons: Iterable[dict[str, Any]]) -> list[str]:
    formatted: list[str] = []
    for button in gpio_buttons:
        if not isinstance(button, dict):
            continue
        label = str(button.get("label") or "").strip()
        pin = button.get("pin")
        pin_display = None
        if isinstance(pin, (int, float)) and int(pin) > 0:
            pin_display = str(int(pin))
        elif isinstance(pin, str) and pin.strip().isdigit():
            pin_display = str(int(pin.strip()))
        if label and pin_display:
            formatted.append(f"{label} (pin {pin_display})")
        elif label:
            formatted.append(label)
        elif pin_display:
            formatted.append(f"Pin {pin_display}")
    return formatted


def format_frame_context(frame: dict[str, Any] | None) -> str | None:
    if not frame:
        return None
    lines: list[str] = []
    name = frame.get("name")
    if isinstance(name, str) and name.strip():
        lines.append(f"- Frame name: {name.strip()}")
    width = frame.get("width")
    height = frame.get("height")
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        lines.append(f"- Resolution: {width}x{height}")
    device = frame.get("device")
    if isinstance(device, str) and device.strip():
        lines.append(f"- Device: {device.strip()}")
    color = frame.get("color")
    if isinstance(color, str) and color.strip():
        lines.append(f"- Color mode: {color.strip()}")
    gpio_buttons = frame.get("gpio_buttons") or frame.get("gpioButtons") or []
    if isinstance(gpio_buttons, list) and gpio_buttons:
        formatted_buttons = _format_gpio_buttons(gpio_buttons)
        if formatted_buttons:
            lines.append(f"- GPIO buttons: {', '.join(formatted_buttons)}.")
            lines.append(
                "- To use a GPIO button, add an event node with data "
                '{"keyword": "button", "label": "A"} (replace "A" with the button label), '
                "then follow with whatever you want (usually a logic/setAsState and a dispatch render)."
            )
    return "\n".join(lines) if lines else None


def format_frame_scene_summary(scenes: list[dict[str, Any]] | None) -> str:
    if not scenes:
        return "No scenes are installed on this frame yet."
    lines: list[str] = ["Installed scenes (short summary):"]
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        scene_id = scene.get("id")
        scene_name = scene.get("name") or scene_id or "Untitled scene"
        nodes = scene.get("nodes") or []
        edges = scene.get("edges") or []
        app_keywords: list[str] = []
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                if node.get("type") != "app":
                    continue
                keyword = (node.get("data") or {}).get("keyword")
                if isinstance(keyword, str) and keyword not in app_keywords:
                    app_keywords.append(keyword)
        apps_summary = ""
        if app_keywords:
            preview = ", ".join(app_keywords[:3])
            suffix = "…" if len(app_keywords) > 3 else ""
            apps_summary = f" Apps: {preview}{suffix}."
        scene_label = f"{scene_name}"
        if scene_id and scene_id != scene_name:
            scene_label = f"{scene_name} (id: {scene_id})"
        lines.append(f"- {scene_label}: {len(nodes)} nodes, {len(edges)} edges.{apps_summary}")
    return "\n".join(lines)


def format_available_apps(apps: Iterable[str] | None) -> str | None:
    if not apps:
        return None
    unique_apps = sorted({app for app in apps if isinstance(app, str) and app.strip()})
    if not unique_apps:
        return None
    return "Available app keywords (authoritative): " + ", ".join(unique_apps)


def _format_selected_elements(
    selected_nodes: list[dict[str, Any]] | None,
    selected_edges: list[dict[str, Any]] | None,
) -> str | None:
    parts: list[str] = []
    if selected_nodes:
        parts.append(f"Selected nodes: {json.dumps(selected_nodes, ensure_ascii=False)}")
    if selected_edges:
        parts.append(f"Selected edges: {json.dumps(selected_edges, ensure_ascii=False)}")
    return "\n".join(parts) if parts else None

# The rules of a scene are the scene guide's (docs/scene-guide.md), the same
# text the cloud's scene AI and both MCP servers serve; what is left here is
# what this generator answers with.
SCENE_JSON_SYSTEM_PROMPT = (
    """
You are a FrameOS scene generator. Build scenes JSON that can be uploaded to FrameOS.
Return a JSON object with a top-level "title" string and a "scenes" array: no markdown, no code fences.
- Use ONLY app keywords from the provided context. When none fits, use "render/text" with a short message.
- A node may name a repo/apps/<folder>/<name> app by that keyword: it is copied into the scene's apps map for you.
- Leave out node positions.
- Use any relevant scene examples from the provided context as guidance.

The FrameOS scene guide follows: how scenes work on every frame. Follow it.

"""
    + SCENE_GUIDE
).strip()

SCENE_CHAT_ROUTER_SYSTEM_PROMPT = """
You are a router that decides how to handle a FrameOS scene chat request.
Choose exactly one tool:
- build_scene: The user wants a new scene generated.
- modify_scene: The user wants edits to the current scene JSON.
- answer_frame_question: The user is asking about the frame, FrameOS, or how things work.
- answer_scene_question: The user is asking about the current scene, how it works, or how to edit it.
- reply: The user is chatting without needing tools.
Return JSON only with:
- tool: one of "build_scene", "modify_scene", "answer_frame_question", "answer_scene_question", "reply"
- tool_prompt: a concise prompt for the chosen tool (or the original user request if no rewrite is needed)
Rules:
- If there is no current scene provided, avoid "modify_scene".
- If there is no current scene provided, do not use "answer_scene_question".
- Use "build_scene" when the user asks to create something new or add a new scene.
- Use "modify_scene" when the user asks to change "this scene", "the current scene", or references an existing scene.
- Use "answer_scene_question" for explanations, diagnostics, or how-to questions about the current scene.
- Use "answer_frame_question" for frame-level questions (device settings, installed scenes, how FrameOS works).
""".strip()

SCENE_MODIFY_SYSTEM_PROMPT = (
    SCENE_JSON_SYSTEM_PROMPT
    + "\n\n"
    + """
You are modifying an existing FrameOS scene. You will receive the current scene JSON and a user request.
Return updated JSON with a top-level "title" and "scenes" array.
Keep the scene id and name unless the user explicitly asks to change them.
Only adjust what the user requested; preserve existing structure when possible.
You will be given an authoritative list of available app keywords. Use only those app keywords; do not invent new apps.
""".strip()
)

FRAME_CHAT_ANSWER_SYSTEM_PROMPT = """
You are a friendly assistant for FrameOS frames.
Answer questions about the frame or FrameOS itself.
Use the provided context (frame details, installed scene summary, and reference context).

High-level FrameOS facts you can use:
- FrameOS is an operating system for single-function smart frames built for Raspberry Pi-class hardware.
- It supports both e-ink and traditional displays, including very low refresh (seconds per frame) and high refresh
  (up to 60fps) screens, with example use cases like calendars, meeting room displays, dashboards, signage, and
  interactive message boards.
- Frames run a compiled on-device runtime (written in Nim) and operate locally; there is no required cloud
  subscription. The backend is used to configure, deploy, and manage frames over SSH.
- The backend can run locally or on a server, is available as a Docker app (and Home Assistant addon), and serves a
  web UI for creating and deploying scenes.
- Users can deploy prebuilt scenes or create their own in the scene editor; scenes are made of apps/nodes wired
  together for data and rendering.
- Common hardware includes Raspberry Pi + e-ink HATs (Waveshare/Pimoroni) or HDMI displays; Raspberry Pi OS Lite is a
  typical base OS.

Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
Limit answers to a few short paragraphs (2-3 max) and avoid long lists unless the user asks.
Invite follow-up questions and make it clear they can ask about other scenes too.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
""".strip()

SCENE_CHAT_ANSWER_SYSTEM_PROMPT = """
You are a friendly assistant for FrameOS scenes.
Answer questions about the current scene or how to edit it.
Use the provided context (scene JSON, selected nodes/edges, frame details, and reference context).
Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
Limit answers to a few short paragraphs (2-3 max) and avoid long lists unless the user asks.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
""".strip()

SCENE_PLAN_SYSTEM_PROMPT = """
You are planning a FrameOS scene. Produce a concise plan that will be compiled into scene JSON later.
If the app is so complex that it requires processed input data to be read multiple times, store the processed output in
a private state field with the "logic/setAsState" app, then read it back via state nodes later.
Return JSON with keys:
- title: optional string for the scene.
- intent: short statement of what the user wants.
- components: array of app keywords or scene concepts to include.
- layout: short description of layout/placement strategy.
- data_flow: short description of how data flows into render/logic apps.
- open_questions: array of strings for missing info; leave empty if not needed.
Do not include markdown or code fences.
""".strip()

SCENE_REVIEW_SYSTEM_PROMPT = """
You are a strict reviewer for FrameOS scene JSON.
Check the scene against the user request and ensure it is valid:
- It has a top-level "scenes" array with at least one scene.
- Each scene has id, name, nodes, edges, and settings.execution = "interpreted".
- There is at least one event node with data.keyword = "render".
- Every edge references existing node ids for source and target.
- Logic apps should be connected via prev/next or field output/input edges. Data apps (keywords starting with "data/") do
  NOT need to be in the prev/next render chain and should not be flagged for that; they are executed via data edges.
- Code nodes and state nodes are NOT part of the prev/next render chain; do not require or suggest they be connected via
  appNodeEdge. They should only connect via codeNodeEdge edges.
- Apps (including render apps) may be in the prev/next render flow and also receive field inputs or emit field outputs.
- Code/state output handles must be exactly "fieldOutput". Do not require or suggest named handles like "fieldOutput/<name>".
- All state fields include a default "value" field which is a string.
- Duplicate state nodes that reference the same field keyword are allowed (they may be duplicated for clarity in routing).
- The render flow does not branch: no multiple "next" edges point to the same "prev" handle.
- If two nodes are connected via prev/next, they should not also be connected by any other edge type.
- No image output is stored as state in JSON; image outputs must be wired directly into app inputs.
- FrameOS scenes always render a visual output. The render event sets up context.image. Apps connected via prev/next operate
  on that shared canvas without needing it passed through inputs.
- Frame details (frame name, resolution, device, GPIO buttons) are optional context hints. Do NOT require them to be encoded
  in the scene unless the user explicitly asked to reference them.
- Do not require render app configs to include resolution or size metadata unless the user explicitly asked for it.
- GPIO buttons are optional hardware hints. Only require button events or button-driven logic if the user explicitly asked for
  a GPIO button interaction.
- Be pragmatic about user-request matching: only flag clear contradictions or missing must-have elements. Do not be overly critical
  about stylistic differences or exact phrasing.
- Do not suggest or imply changing the scene title during review. Title changes are not part of review feedback.
Respond with JSON only, using keys:
- solves: boolean (true only if the scene matches the user request)
- issues: array of short strings describing any problems
""".strip()

def category_info(category: str) -> str:
    category_map = {
        "render": "produces visual output, can either be connected next/prev or used standalone with field inputs/outputs",
        "logic": "processes data or logic, can only be connected next/prev, not used via field outputs",
        "data": "provides data, cannot be connected next/prev, only used via field outputs",
    }
    return category_map.get(category, "unknown category")

def _format_context_items(items: list[AiCatalogItem]) -> str:
    lines: list[str] = []
    for item in items:
        metadata = item.metadata_json or {}
        header = f"[{"example scene" if item.source_type == "scene" else item.source_type}] {item.name or item.source_path}"
        keyword = metadata.get("keyword")
        app_category = metadata.get("appCategory") or ""
        category = metadata.get("category") or app_category
        app_keywords = metadata.get("appKeywords") or []
        event_keywords = metadata.get("eventKeywords") or []
        node_types = metadata.get("nodeTypes") or []
        fields = metadata.get("fieldDetails") or metadata.get("fields") or []
        outputs = metadata.get("outputDetails") or metadata.get("outputs") or []
        scene_json = metadata.get("scene") or {}
        lines.append(
            "\n".join(
                line for line in [
                    header,
                    f"Summary: {item.summary}",
                    f"Keyword: {keyword}" if keyword else "",
                    f"App category: {category} ({category_info(category)})" if category else "",
                    f"App keywords used: {', '.join(app_keywords)}" if app_keywords else "",
                    f"Event keywords used: {', '.join(event_keywords)}" if event_keywords else "",
                    f"Node types: {', '.join(node_types)}" if node_types else "",
                    f"Fields: {json.dumps(fields, ensure_ascii=False)}" if fields else "",
                    f"Outputs: {json.dumps(outputs, ensure_ascii=False)}" if outputs else "",
                    f"Scene JSON (condensed): {json.dumps(scene_json, ensure_ascii=False)}" if scene_json else "",
                ] if line != ""
            )
        )
    return "\n\n".join(lines)


def _format_reference_context(catalog_context: str | None, context_items: list[AiCatalogItem]) -> str:
    parts: list[str] = []
    if catalog_context:
        parts.append(catalog_context)
    item_context = _format_context_items(context_items)
    if item_context:
        parts.extend(["Selected detailed entries:", item_context])
    return "\n\n".join(parts)


_disabled_posthog_client: PostHogClient | None = None


def _noop_posthog_client() -> PostHogClient:
    # posthog.ai's AsyncOpenAI falls back to the global posthog client when
    # posthog_client is None and raises "API key is required" if analytics was
    # never configured. Hand it a disabled client so AI features keep working
    # on installs without PostHog.
    global _disabled_posthog_client
    if _disabled_posthog_client is None:
        _disabled_posthog_client = PostHogClient("disabled", disabled=True)
    return _disabled_posthog_client


def _openai_client(api_key: str) -> AsyncOpenAI:
    posthog_client = get_posthog_client() if llm_analytics_enabled() else None
    return AsyncOpenAI(
        api_key=api_key,
        posthog_client=posthog_client or _noop_posthog_client(),
        timeout=AI_REQUEST_TIMEOUT,
    )


def _sanitize_ai_id(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9\\-_.@()!'~:|]", "_", value)
    return cleaned or None


def _new_ai_span_id() -> str:
    return str(uuid4())


def _build_ai_posthog_properties(
    *,
    model: str,
    ai_trace_id: str | None,
    ai_session_id: str | None,
    ai_span_id: str | None,
    ai_parent_id: str | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "$ai_trace_id": _sanitize_ai_id(ai_trace_id),
        "$ai_session_id": _sanitize_ai_id(ai_session_id),
        "$ai_span_id": _sanitize_ai_id(ai_span_id),
        "$ai_parent_id": _sanitize_ai_id(ai_parent_id),
        "$ai_model": model,
    }
    properties = {key: value for key, value in properties.items() if value is not None}
    if extra:
        properties.update(extra)
    return properties


async def generate_scene_json(
    *,
    prompt: str,
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    api_key: str,
    model: str,
    plan: dict[str, Any] | None = None,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_reference_context(catalog_context, context_items)
    scene_prompt_parts = [f"User request: {prompt}"]
    if plan:
        scene_prompt_parts.append(f"Scene plan: {json.dumps(plan, ensure_ascii=False)}")
    scene_prompt_parts.extend(
        [
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    scene_prompt = "\n\n".join(scene_prompt_parts)
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_JSON_SYSTEM_PROMPT + ("\n\n" + frame_context if frame_context else "")},
            {"role": "user", "content": scene_prompt},
        ],
        context_items=context_items,
        ai_trace_id=ai_trace_id,
        ai_session_id=ai_session_id,
        ai_parent_id=ai_parent_id,
    )


async def generate_scene_plan(
    *,
    prompt: str,
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    api_key: str,
    model: str,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_reference_context(catalog_context, context_items)
    plan_prompt_parts = [f"User request: {prompt}"]
    if frame_context:
        plan_prompt_parts.extend(["Frame details:", frame_context])
    plan_prompt_parts.extend(
        [
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    plan_prompt = "\n\n".join(plan_prompt_parts)
    return await _request_scene_plan(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_PLAN_SYSTEM_PROMPT},
            {"role": "user", "content": plan_prompt},
        ],
        context_items=context_items,
        ai_trace_id=ai_trace_id,
        ai_session_id=ai_session_id,
        ai_parent_id=ai_parent_id,
    )


async def route_scene_chat(
    *,
    prompt: str,
    api_key: str,
    scene: dict[str, Any] | None = None,
    frame_context: str | None = None,
    history: list[dict[str, str]] | None = None,
    model: str = CHAT_MODEL,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    prompt_parts = [f"User request: {prompt}"]
    if frame_context:
        prompt_parts.extend(["Frame details:", frame_context])
    if scene:
        prompt_parts.extend(["Current scene JSON:", json.dumps(scene, ensure_ascii=False)])
    if history:
        history_lines = [
            f"{item.get('role')}: {item.get('content')}"
            for item in history
            if isinstance(item, dict) and item.get("role") and item.get("content")
        ]
        if history_lines:
            prompt_parts.extend(["Recent chat history:", "\n".join(history_lines)])
    routing_prompt = "\n\n".join(prompt_parts)
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or CHAT_MODEL,
        messages=[
            {"role": "system", "content": SCENE_CHAT_ROUTER_SYSTEM_PROMPT},
            {"role": "user", "content": routing_prompt},
        ],
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or CHAT_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "route_scene_chat",
                "model": model or CHAT_MODEL,
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def modify_scene_json(
    *,
    prompt: str,
    scene: dict[str, Any],
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    available_apps: Iterable[str] | None = None,
    api_key: str,
    model: str,
    issues: list[str] | None = None,
    frame_context: str | None = None,
    selected_nodes: list[dict[str, Any]] | None = None,
    selected_edges: list[dict[str, Any]] | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_reference_context(catalog_context, context_items)
    prompt_parts = [f"User request: {prompt}", "Current scene JSON:", json.dumps(scene, ensure_ascii=False)]
    available_apps_block = format_available_apps(available_apps)
    if available_apps_block:
        prompt_parts.append(available_apps_block)
    selected_context = _format_selected_elements(selected_nodes, selected_edges)
    if selected_context:
        prompt_parts.extend(["User selection in editor:", selected_context])
    if issues:
        prompt_parts.append(f"Known issues: {json.dumps(issues, ensure_ascii=False)}")
    if frame_context:
        prompt_parts.extend(["Frame details:", frame_context])
    prompt_parts.extend(
        [
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    scene_prompt = "\n\n".join(prompt_parts)
    system_prompt = SCENE_MODIFY_SYSTEM_PROMPT + ("\n\n" + frame_context if frame_context else "")
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": scene_prompt},
        ],
        context_items=context_items,
        ai_trace_id=ai_trace_id,
        ai_session_id=ai_session_id,
        ai_parent_id=ai_parent_id,
    )


async def answer_scene_question(
    *,
    prompt: str,
    api_key: str,
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    frame_context: str | None = None,
    scene: dict[str, Any] | None = None,
    selected_nodes: list[dict[str, Any]] | None = None,
    selected_edges: list[dict[str, Any]] | None = None,
    history: list[dict[str, str]] | None = None,
    model: str = CHAT_MODEL,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> str:
    context_block = _format_reference_context(catalog_context, context_items)
    context_parts = []
    if frame_context:
        context_parts.extend(["Frame details:", frame_context])
    if scene:
        context_parts.extend(["Current scene JSON:", json.dumps(scene, ensure_ascii=False)])
    selected_context = _format_selected_elements(selected_nodes, selected_edges)
    if selected_context:
        context_parts.extend(["User selection in editor:", selected_context])
    if context_block:
        context_parts.extend(["Relevant reference context:", context_block])
    context_message = "\n\n".join(context_parts) if context_parts else "No additional context."
    messages = [{"role": "system", "content": SCENE_CHAT_ANSWER_SYSTEM_PROMPT}, {"role": "user", "content": context_message}]
    if history:
        for item in history:
            role = item.get("role") if isinstance(item, dict) else None
            content = item.get("content") if isinstance(item, dict) else None
            if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
                messages.append({"role": role, "content": content.strip()})
    messages.append({"role": "user", "content": prompt})
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or CHAT_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or CHAT_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "answer_scene_question",
                "model": model or CHAT_MODEL,
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    payload = json.loads(content)
    answer = payload.get("answer")
    if isinstance(answer, str) and answer.strip():
        return answer.strip()
    return content.strip()


async def answer_frame_question(
    *,
    prompt: str,
    api_key: str,
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    frame_context: str | None = None,
    frame_scene_summary: str | None = None,
    history: list[dict[str, str]] | None = None,
    model: str = CHAT_MODEL,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> str:
    context_block = _format_reference_context(catalog_context, context_items)
    context_parts = []
    if frame_context:
        context_parts.extend(["Frame details:", frame_context])
    if frame_scene_summary:
        context_parts.extend(["Installed scenes:", frame_scene_summary])
    if context_block:
        context_parts.extend(["Relevant reference context:", context_block])
    context_message = "\n\n".join(context_parts) if context_parts else "No additional context."
    messages = [{"role": "system", "content": FRAME_CHAT_ANSWER_SYSTEM_PROMPT}, {"role": "user", "content": context_message}]
    if history:
        for item in history:
            role = item.get("role") if isinstance(item, dict) else None
            content = item.get("content") if isinstance(item, dict) else None
            if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
                messages.append({"role": role, "content": content.strip()})
    messages.append({"role": "user", "content": prompt})
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or CHAT_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or CHAT_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "answer_frame_question",
                "model": model or CHAT_MODEL,
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    payload = json.loads(content)
    answer = payload.get("answer")
    if isinstance(answer, str) and answer.strip():
        return answer.strip()
    return content.strip()


def validate_scene_payload(payload: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return ["Scene payload must include a non-empty scenes array."]
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            issues.append(f"Scene {index} is not an object.")
            continue
        scene_id = scene.get("id")
        scene_name = scene.get("name")
        nodes = scene.get("nodes")
        edges = scene.get("edges")
        settings = scene.get("settings") or {}
        if not scene_id or not scene_name:
            issues.append(f"Scene {index} is missing id or name.")
        if not isinstance(nodes, list) or not nodes:
            issues.append(f"Scene {index} must include nodes.")
            continue
        if not isinstance(edges, list):
            issues.append(f"Scene {index} must include edges.")
            continue
        if settings.get("execution") not in (None, "interpreted"):
            issues.append(f"Scene {index} settings.execution must be 'interpreted'.")
        node_ids: set[str] = set()
        render_event_found = False
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_id = node.get("id")
            if isinstance(node_id, str):
                if node_id in node_ids:
                    issues.append(f"Scene {index} has duplicate node id {node_id}.")
                node_ids.add(node_id)
            node_type = node.get("type")
            data = node.get("data") or {}
            if node_type == "event" and data.get("keyword") == "render":
                render_event_found = True
        if not render_event_found:
            issues.append(f"Scene {index} is missing a render event node.")
        for edge in edges:
            if not isinstance(edge, dict):
                issues.append(f"Scene {index} has an edge that is not an object.")
                continue
            source = edge.get("source")
            target = edge.get("target")
            if source not in node_ids:
                issues.append(f"Scene {index} edge source '{source}' is not a valid node id.")
            if target not in node_ids:
                issues.append(f"Scene {index} edge target '{target}' is not a valid node id.")
    return issues


async def review_scene_solution(
    *,
    prompt: str,
    payload: dict[str, Any],
    api_key: str,
    model: str = SCENE_REVIEW_MODEL,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> list[str]:
    review_prompt_parts = [f"User request: {prompt}"]
    if frame_context:
        review_prompt_parts.extend(["Frame details:", frame_context])
    review_prompt_parts.extend(
        [
            "Scene JSON:",
            json.dumps(payload, ensure_ascii=False),
        ]
    )
    review_prompt = "\n\n".join(review_prompt_parts)
    response = await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": review_prompt},
        ],
        context_items=[],
        ai_trace_id=ai_trace_id,
        ai_session_id=ai_session_id,
        ai_parent_id=ai_parent_id,
    )
    solves = response.get("solves")
    issues = response.get("issues")
    if solves is True:
        return []
    if isinstance(issues, list) and issues:
        return [str(issue) for issue in issues]
    return ["Scene review did not confirm the response solves the request."]


async def repair_scene_json(
    *,
    prompt: str,
    context_items: list[AiCatalogItem],
    catalog_context: str | None = None,
    api_key: str,
    model: str,
    payload: dict[str, Any],
    issues: list[str],
    plan: dict[str, Any] | None = None,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_reference_context(catalog_context, context_items)
    scene_prompt_parts = [
        f"User request: {prompt}",
        f"Reviewer issues: {json.dumps(issues, ensure_ascii=False)}",
    ]
    if plan:
        scene_prompt_parts.append(f"Scene plan: {json.dumps(plan, ensure_ascii=False)}")
    if frame_context:
        scene_prompt_parts.extend(["Frame details:", frame_context])
    scene_prompt_parts.extend(
        [
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    scene_prompt = "\n\n".join(scene_prompt_parts)
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_JSON_SYSTEM_PROMPT},
            {"role": "user", "content": scene_prompt},
        ],
        context_items=context_items,
        ai_trace_id=ai_trace_id,
        ai_session_id=ai_session_id,
        ai_parent_id=ai_parent_id,
    )


async def _request_scene_json(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    context_items: list[AiCatalogItem],
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or SCENE_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or SCENE_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "generate_scene_json",
                "model": model or SCENE_MODEL,
                "context_items": len(context_items),
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def _request_scene_plan(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    context_items: list[AiCatalogItem],
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or SCENE_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or SCENE_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "generate_scene_plan",
                "model": model or SCENE_MODEL,
                "context_items": len(context_items),
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)
