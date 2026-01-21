import json
import re
from typing import Any, Iterable
from uuid import uuid4

import numpy as np
from posthog.ai.openai import AsyncOpenAI

from app.models.ai_embeddings import AiEmbedding
from app.config import config
from app.utils.posthog import get_posthog_client, llm_analytics_enabled

SUMMARY_MODEL = "gpt-5-mini"
SCENE_MODEL = "gpt-5.2"
CHAT_MODEL = "gpt-5-mini"
EMBEDDING_MODEL = "text-embedding-3-large"
SCENE_REVIEW_MODEL = "gpt-5-mini"
PROMPT_EXPANSION_MODEL = "gpt-5-mini"

DEFAULT_APP_CONTEXT_K = 6
DEFAULT_SCENE_CONTEXT_K = 4
DEFAULT_MIN_SCORE = 0.15
MMR_LAMBDA = 0.7
AI_REQUEST_TIMEOUT = 600


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

SUMMARY_SYSTEM_PROMPT = """
You are summarizing FrameOS scene templates and app modules so they can be retrieved for prompt grounding.
Return JSON with keys:
= type: app or scene. if app, if it's a render/logic/data app.
- summary: 2-4 sentences describing what it does and which apps or data it uses.
- keywords: 5-10 short keywords or phrases.
Keep the summary concise and technical. Do not include markdown.
""".strip()

SCENE_JSON_SYSTEM_PROMPT = """
You are a FrameOS scene generator. Build scenes JSON that can be uploaded to FrameOS.
Reference TypeScript shapes (for structure sanity):
- Scene: { id: string, name: string, nodes: Node[], edges: Edge[], settings: { execution: "interpreted", ... }, fields?: Field[] }
- Node: { id: string, type: "event"|"dispatch"|"app"|"state"|"code"|"scene", data: NodeData, position?: { x:number, y:number } }
- Edge: { id?: string, type?: "appNodeEdge"|"codeNodeEdge", source: string, target: string, sourceHandle?: string, targetHandle?: string }
- Field: { name: string, type: FieldType, label?: string, description?: string, required?: boolean, value?: any, options?: string[] }
- NodeData:
  - EventNodeData: { keyword: string }
  - DispatchNodeData: { keyword: string, config: object }
  - AppNodeData: { keyword: string, config: object, sources?: object, cache?: object }
  - StateNodeData: { keyword: string }
  - CodeNodeData: { codeJS?: string, code?: string, codeArgs?: { name: string, type: FieldType }[], codeOutputs?: { name: string, type: FieldType }[], cache?: object, logOutput?: boolean }
  - SceneNodeData: { keyword: string, config: object }
- FieldType: "string"|"text"|"float"|"integer"|"boolean"|"color"|"date"|"json"|"node"|"scene"|"image"|"font"|"select"
Follow these rules:
- Output a JSON object with a top-level "title" string and "scenes" array. No markdown or code fences.
- Each scene must include: id (string), name (string), nodes (array), edges (array).
- Each scene must include settings.execution = "interpreted" (never "compiled").
- Each node must include: id (string), type (see below), data (object). Ignore positions.
- Supported node types: "event", "dispatch", "app", "state", "code", "scene".
- Edges can be of type "appNodeEdge" or "codeNodeEdge".
- Edges of type "appNodeEdge" connect app nodes (sourceHandle "next" to targetHandle "prev") or layout app fields (e.g. "field/render_functions[row][col]" to "prev").
- Edges of type "codeNodeEdge" connect code or state node outputs (sourceHandle "fieldOutput") to app or code node inputs (targetHandle "fieldInput/<fieldName>" or "codeField/<argName>").
- There is only one source handle for code/state outputs: "fieldOutput". Do NOT use "fieldOutput/<name>" or any named variants.
- Each scene starts from one event node with data.keyword = "render" to trigger rendering.
- Each connected render or logic node is executed in sequence via appNodeEdge edges.
- To trigger a re-render (for example after setting state), add a dispatch node with data.keyword = "render" and connect it in the appNodeEdge flow.
- Dispatch nodes are separate from apps; do not use app keywords like "dispatch/render".
- App nodes are generic. For the actual data to render, use code nodes or data apps connected via codeNodeEdge edges.
- If you want to render an image and then render text on top, use a render/image app node followed by a render/text app node,
  connecting them via appNodeEdge (next/prev), and connect the image data into the image app via codeNodeEdge.
- You can't have dangling specialized image rendering apps! E.g. do not use render/openaiImage alone; instead, ALWAYS connect its output into a
  render/image app, and connect the render/image app into the render flow.
- Logic apps (category "logic") can be used to process data; render apps (category "render") produce visual output.
- Data apps (category "data") provide data and must not be connected left/right in the render flow.
- Code nodes have only one output. The codeoutputs array must only contain one output, connected via "fieldOutput". The name is arbitrary and for reference only; do not encode it into the handle.
- Code nodes can include JavaScript snippets in data.codeJS for interpreted scenes.
- Code nodes arguments are used as variables in the code snippet, just <argNamen> (no args. prefix).
- State nodes hold scene fields; set data.keyword to the field name. Use scene fields to allow user customization.
- Every state node must include data.value as a string default (use "" unless the prompt specifies a different default).
- Scene nodes embed other scenes; set data.keyword to the scene id.
- App node data must include data.keyword (app identifier) and data.config (app configuration).
- Data apps (e.g. "data/openaiText", "data/openaiImage") provide data via codeNodeEdge edges.
- Use ONLY app keywords from the provided context. If none match, use "render/text" and a simple message.
- Prefer minimal but valid configs; omit fields when not needed.
- Do not add node positions.
- Ensure number types match: connect floats to float fields and integers to integer fields; do not mix numeric types.
- When defining scene fields, set access = "public" and persist = "disk" unless there is a specific reason not to. This way users can modify them.
- Text apps can render rich text using the simple caret syntax (basic-caret) to display dynamic text.
  Use caret tokens like ^(16) for font size, ^(#FF00FF) for color, ^(PTSans-Bold.ttf) for font,
  ^(underline)/^(no-underline), ^(strikethrough)/^(no-strikethrough), combine styles via ^(16,#FF0000),
  and reset styles with ^(reset).
- State nodes are used to supply scene fields into code/app inputs: set data.keyword to the scene field name and connect
  them via codeNodeEdge with sourceHandle "fieldOutput" (no suffixes) to targetHandle "fieldInput/<fieldName>" or "codeField/<argName>".
- When multiple apps use the same state field, duplicate the state node for each app to keep routing clearer in the diagram.
- Create edges that link the nodes into a valid flow:
  - Use "appNodeEdge" with sourceHandle "next" and targetHandle "prev" to connect the render event to the first app,
    and to connect each subsequent app node in order.
  - Do not connect multiple "next" edges to the same "prev" handle. The render flow must be a single linear chain
    where each app node connects to exactly one next node in sequence.
  - If two nodes are connected via prev/next, do not connect those same nodes via any other edge type.
  - Logic + render apps form the left/right render flow (prev/next). Data apps are not part of the left/right chain
    and should only connect up/down via field output -> field input edges.
  - Apps in the render flow may still receive field inputs or emit field outputs; field wiring does NOT disqualify an
    app from being in the prev/next chain.
  - Only apps with category "logic" or "render" can be connected left/right using appNodeEdge. Apps with category
    "data" must not be connected left/right and must only connect via field outputs into inputs.
  - When an app outputs data into another app's input (e.g. data app into render/image), add a "codeNodeEdge" from
    sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>".
  - Every app node must be connected either through the render flow (prev/next) or via a field output/input edge.
- Data apps (including image apps) are up/down data providers and should NOT be chained into the render flow using
    "appNodeEdge". Instead, connect the render event directly to the render app (e.g. "render/image") with
    "appNodeEdge" and separately connect the data app output via "codeNodeEdge". This keeps the render flow triggered
    by the event.
  - Render/logic apps connected via prev/next always share the implicit context.image canvas. Do not pass the canvas
    through inputs when the app is in the prev/next chain.
  - If render apps are connected via field outputs instead of prev/next, the image data must be passed along (or
    generated) via field outputs/inputs as required.
  - Images are data. To display an image, first add a render app like "render/image" in the render flow, then connect
    the actual image output into its image field via a "codeNodeEdge" (fieldOutput -> fieldInput/imageField).
  - Never store an image output node as state in JSON; pass image outputs directly into app inputs via codeNodeEdge.
  - If you include an OpenAI image app (keyword "data/openaiImage"), do not set scene refreshInterval below 3600 unless
    the user explicitly asks for a faster update cadence.
- If you include a "code" node, connect its outputs to app inputs using "codeNodeEdge" with targetHandle
  "fieldInput/<fieldName>".
- If you include scene fields, add matching "state" nodes with data.keyword = field name, and connect them via
  "codeNodeEdge" to "code" nodes using targetHandle "codeField/<argName>" or directly to app inputs using
  "fieldInput/<fieldName>".
- Code nodes can be added anywhere for most fields (see "Haiku of the hour" for an example); only data.codeJS
  needs to be filled in for interpreted scenes.
- If you must use template strings, use code nodes with backticks. Do not use template strings directly in app configs.
- If you include "scene" nodes (to embed another scene), set data.keyword to the referenced scene id and connect them
  from a layout app (like "render/split") using "appNodeEdge" with sourceHandle
  "field/render_functions[row][col]" and targetHandle "prev".
- If you want to reduce the opacity of an image, render the image as a data node, then connect it to the "render/opacity"
  app as "image" and "opacity", and connect that to the "render/image" app in the render flow.
- If you render a "render/color" or "render/gradient" background, you will wipe out all that was there before.
- For render/text nodes, if there's no text to render (no value, no code node), omit the node.
- Scene settings:
  - settings.refreshInterval is the render cadence in seconds. Use it to control how often the scene re-renders.
    If a user mentions a render timeout or cadence, set refreshInterval accordingly (do not invent new timeout fields).
  - settings.backgroundColor sets the default scene background fill as a hex color (e.g. "#000000").
    If not specified, it defaults to black. Use render/color or render/gradient apps for more complex backgrounds.
    Setting backgroundColor ensures the scene starts rendering with that background; do not add a separate blank-screen step.
- For complex scenes, split data gathering from data rendering. Use data/logic apps or code nodes to gather/compute data,
  then persist JSON-friendly outputs (scalars, strings, objects, arrays) with the "logic/setAsState" app by wiring the
  output into fieldInput/valueJson. Later, read them back by referencing "state.<name>" via state nodes (keyword = name).
- Fonts available (TTF filenames) for font fields and caret syntax:
  - Ubuntu: Ubuntu-Regular.ttf (default), Ubuntu-Bold.ttf, Ubuntu-Italic.ttf, Ubuntu-BoldItalic.ttf,
    Ubuntu-Light.ttf, Ubuntu-LightItalic.ttf, Ubuntu-Medium.ttf, Ubuntu-MediumItalic.ttf.
  - PTSans: PTSans-Regular.ttf, PTSans-Bold.ttf, PTSans-Italic.ttf, PTSans-BoldItalic.ttf.
  - FiraGO: FiraGO-Regular.ttf, FiraGO-Italic.ttf, FiraGO-Bold.ttf, FiraGO-BoldItalic.ttf,
    FiraGO-Medium.ttf, FiraGO-MediumItalic.ttf, FiraGO-Light.ttf, FiraGO-LightItalic.ttf,
    FiraGO-ExtraLight.ttf, FiraGO-ExtraLightItalic.ttf, FiraGO-SemiBold.ttf, FiraGO-SemiBoldItalic.ttf,
    FiraGO-ExtraBold.ttf, FiraGO-ExtraBoldItalic.ttf, FiraGO-Heavy.ttf, FiraGO-HeavyItalic.ttf,
    FiraGO-Book.ttf, FiraGO-BookItalic.ttf, FiraGO-Thin.ttf, FiraGO-ThinItalic.ttf.
  - CormorantGaramond: Regular/Bold/Italic/BoldItalic/Light/LightItalic/Medium/MediumItalic/SemiBold/SemiBoldItalic.
  - Liberation: LiberationSans-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf,
    LiberationSerif-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf,
    LiberationMono-Regular.ttf/Bold.ttf/Italic.ttf/BoldItalic.ttf.
  - Other: CascadiaMono.ttf, CascadiaMonoItalic.ttf, ComicRelief.ttf, ComicRelief-Bold.ttf,
    Galindo-Regular.ttf, Peralta-Regular.ttf.
  - Users may upload custom fonts; if a requested font is unavailable, choose the closest available font or make it
    a scene field so it can be swapped later.
- Cache config can be applied to app or code nodes via data.cache with:
  - enabled: true to turn caching on.
  - inputEnabled: cache by inputs (output recalculates when any inputs change).
  - durationEnabled + duration (seconds): refresh after a fixed interval.
  - You can combine inputEnabled with an expression or duration to cache per inputs but still refresh on a schedule,
    e.g. cache by inputs and use an expression for the current date so it reloads once per day.
  - Alternatively, add a code node that outputs a date string and feed it into the app as an input; with inputEnabled
    the cache key changes daily because the date input changes.
- Every edge must reference nodes that exist in the "nodes" list. Do not include dangling edges.
- Every state field must include a default value in the "value" field as a String(val) version of itself. No quotes around strings.
- Interpreted scenes can include quick JavaScript snippets in code nodes:
  - Put JS in data.codeJS (not data.code) for interpreted scenes.
  - The QuickJS environment exposes: state.<field>, <argName>, context.<event|payload|loopIndex|loopKey|hasImage>.
  - Console logging is available via console.log/warn/error.
  - Time helpers: parseTs(format, text), format(timestamp, format), now().
  - Keep snippets as expressions that return a value (e.g. "state.title ?? 'Hello'" or "url").
  - If you need multiple statements or setup logic, wrap the snippet in an IIFE and return the value.
  - JavaScript code nodes do not support image outputs. All other types (json, string, boolean, font, etc) are supported.
  - To use SVGs, route them through the download image app and pass a data URL into it.

Use any relevant scene examples from the provided context as guidance.
""".strip()

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
""".strip()
)

FRAME_CHAT_ANSWER_SYSTEM_PROMPT = """
You are a friendly assistant for FrameOS frames.
Answer questions about the frame or FrameOS itself.
Use the provided context (frame details, installed scene summary, and reference context).
Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
Invite follow-up questions and make it clear they can ask about other scenes too.
If the answer is uncertain, say what is missing and how to proceed.
Return JSON only with the key "answer".
""".strip()

SCENE_CHAT_ANSWER_SYSTEM_PROMPT = """
You are a friendly assistant for FrameOS scenes.
Answer questions about the current scene or how to edit it.
Use the provided context (scene JSON, selected nodes/edges, frame details, and reference context).
Provide helpful context without overwhelming the user; keep replies short unless they ask for specifics.
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

PROMPT_EXPANSION_SYSTEM_PROMPT = """
You expand a user request so retrieval can find the best FrameOS apps and scene templates.
Return JSON with keys:
- expanded_prompt: a short, clarified restatement of the request with inferred but non-committal context
  (display style, data sources, layout, cadence). Do not invent requirements.
- keywords: 5-12 short keywords or phrases useful for retrieval.
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
- Apps (including render apps) may be in the prev/next render flow and also receive field inputs or emit field outputs.
- Code/state output handles must be exactly "fieldOutput". Do not require or suggest named handles like "fieldOutput/<name>".
- All state fields include a default "value" field which is a string.
- The render flow does not branch: no multiple "next" edges point to the same "prev" handle.
- If two nodes are connected via prev/next, they should not also be connected by any other edge type.
- No image output is stored as state in JSON; image outputs must be wired directly into app inputs.
- FrameOS scenes always render a visual output. The render event sets up context.image. Apps connected via prev/next operate
  on that shared canvas without needing it passed through inputs.
- Frame details (frame name, resolution, device, GPIO buttons) are optional context hints. Do NOT require them to be encoded
  in the scene unless the user explicitly asked to reference them.
- GPIO buttons are optional hardware hints. Only require button events or button-driven logic if the user explicitly asked for
  a GPIO button interaction.
- Be pragmatic about user-request matching: only flag clear contradictions or missing must-have elements. Do not be overly critical
  about stylistic differences or exact phrasing.
- Do not suggest or imply changing the scene title during review. Title changes are not part of review feedback.
Respond with JSON only, using keys:
- solves: boolean (true only if the scene matches the user request)
- issues: array of short strings describing any problems
""".strip()

def _chunk_texts(texts: Iterable[str], batch_size: int = 64) -> Iterable[list[str]]:
    batch: list[str] = []
    for text in texts:
        batch.append(text)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch

def category_info(category: str) -> str:
    category_map = {
        "render": "produces visual output, can either be connected next/prev or used standalone with field inputs/outputs",
        "logic": "processes data or logic, can only be connected next/prev, not used via field outputs",
        "data": "provides data, cannot be connected next/prev, only used via field outputs",
    }
    return category_map.get(category, "unknown category")

def _format_context_items(items: list[AiEmbedding]) -> str:
    lines: list[str] = []
    for item in items:
        metadata = item.metadata_json or {}
        header = f"[{"example scene" if item.source_type == "scene" else item.source_type}] {item.name or item.source_path}"
        keyword_list = metadata.get("keywords") or []
        app_category = metadata.get("appCategory") or ""
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
                    f"Keywords: {', '.join(keyword_list)}" if keyword_list else "",
                    f"App category: {app_category} ({category_info(app_category)})" if app_category else "",
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


def _cosine_similarity(query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    query_norm = np.linalg.norm(query_vec)
    if query_norm == 0:
        return np.zeros(matrix.shape[0])
    matrix_norm = np.linalg.norm(matrix, axis=1)
    denom = query_norm * matrix_norm
    denom[denom == 0] = 1
    return np.dot(matrix, query_vec) / denom


def _tokenize_prompt(prompt: str) -> list[str]:
    return re.findall(r"[a-z0-9_/.-]+", prompt.lower())


def _keyword_score(prompt_tokens: list[str], item: AiEmbedding) -> float:
    if not prompt_tokens:
        return 0.0
    metadata = item.metadata_json or {}
    keyword_sources = [
        item.name or "",
        item.source_path or "",
        item.summary or "",
        " ".join(metadata.get("keywords") or []),
        " ".join(metadata.get("appKeywords") or []),
        " ".join(metadata.get("eventKeywords") or []),
        " ".join(metadata.get("nodeTypes") or []),
        metadata.get("category") or "",
    ]
    haystack = " ".join(keyword_sources).lower()
    hits = sum(1 for token in prompt_tokens if token in haystack)
    return hits / max(len(prompt_tokens), 1)


def _openai_client(api_key: str) -> AsyncOpenAI:
    posthog_client = get_posthog_client() if llm_analytics_enabled() else None
    return AsyncOpenAI(
        api_key=api_key,
        posthog_client=posthog_client,
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


def _mmr_select(
    items: list[AiEmbedding],
    embeddings: np.ndarray,
    scores: np.ndarray,
    top_k: int,
    lambda_param: float = MMR_LAMBDA,
) -> list[AiEmbedding]:
    if top_k <= 0 or not items:
        return []
    selected: list[int] = []
    candidate_indices = list(range(len(items)))
    while candidate_indices and len(selected) < top_k:
        if not selected:
            best_idx = max(candidate_indices, key=lambda idx: scores[idx])
            selected.append(best_idx)
            candidate_indices.remove(best_idx)
            continue
        best_idx = None
        best_score = -1.0
        for idx in candidate_indices:
            similarity_to_query = scores[idx]
            similarity_to_selected = max(
                _cosine_similarity(embeddings[idx], embeddings[selected]) if selected else np.array([0.0])
            )
            mmr_score = lambda_param * similarity_to_query - (1 - lambda_param) * similarity_to_selected
            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = idx
        if best_idx is None:
            break
        selected.append(best_idx)
        candidate_indices.remove(best_idx)
    return [items[idx] for idx in selected]


def rank_embeddings(
    query_embedding: list[float],
    items: list[AiEmbedding],
    *,
    prompt: str,
    top_k: int = 8,
    min_score: float = DEFAULT_MIN_SCORE,
) -> list[AiEmbedding]:
    if not items:
        return []
    embeddings = np.array([item.embedding for item in items], dtype=float)
    cosine_scores = _cosine_similarity(np.array(query_embedding, dtype=float), embeddings)
    prompt_tokens = _tokenize_prompt(prompt)
    keyword_scores = np.array([_keyword_score(prompt_tokens, item) for item in items], dtype=float)
    combined_scores = (0.7 * cosine_scores) + (0.3 * keyword_scores)
    filtered_indices = [idx for idx, score in enumerate(combined_scores) if score >= min_score]
    if not filtered_indices:
        filtered_indices = list(range(len(items)))
    filtered_items = [items[idx] for idx in filtered_indices]
    filtered_embeddings = embeddings[filtered_indices]
    filtered_scores = combined_scores[filtered_indices]
    return _mmr_select(filtered_items, filtered_embeddings, filtered_scores, top_k=top_k)


async def create_embeddings(
    texts: list[str],
    api_key: str,
    model: str,
    *,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> list[list[float]]:
    embeddings: list[list[float]] = []
    client = _openai_client(api_key)
    for batch in _chunk_texts(texts):
        span_id = _new_ai_span_id()
        response = await client.embeddings.create(
            model=model or EMBEDDING_MODEL,
            input=batch,
            posthog_distinct_id=config.INSTANCE_ID,
            posthog_properties=_build_ai_posthog_properties(
                model=model or EMBEDDING_MODEL,
                ai_trace_id=ai_trace_id,
                ai_session_id=ai_session_id,
                ai_span_id=span_id,
                ai_parent_id=ai_parent_id,
                extra={
                    "operation": "create_embeddings",
                    "model": model or EMBEDDING_MODEL,
                    "input_count": len(batch),
                },
            ),
        )
        for entry in sorted(response.data, key=lambda item: item.index):
            embeddings.append(entry.embedding)
    return embeddings


async def summarize_text(
    text: str,
    api_key: str,
    *,
    model: str = SUMMARY_MODEL,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or SUMMARY_MODEL,
        messages=[
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or SUMMARY_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "summarize_text",
                "model": model or SUMMARY_MODEL,
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def expand_scene_prompt(
    *,
    prompt: str,
    api_key: str,
    model: str = PROMPT_EXPANSION_MODEL,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    prompt_parts = [f"User request: {prompt}"]
    if frame_context:
        prompt_parts.extend(["Frame details:", frame_context])
    expansion_prompt = "\n\n".join(prompt_parts)
    client = _openai_client(api_key)
    span_id = _new_ai_span_id()
    response = await client.chat.completions.create(
        model=model or PROMPT_EXPANSION_MODEL,
        messages=[
            {"role": "system", "content": PROMPT_EXPANSION_SYSTEM_PROMPT},
            {"role": "user", "content": expansion_prompt},
        ],
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties=_build_ai_posthog_properties(
            model=model or PROMPT_EXPANSION_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_span_id=span_id,
            ai_parent_id=ai_parent_id,
            extra={
                "operation": "expand_scene_prompt",
                "model": model or PROMPT_EXPANSION_MODEL,
            },
        ),
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


async def generate_scene_json(
    *,
    prompt: str,
    context_items: list[AiEmbedding],
    api_key: str,
    model: str,
    plan: dict[str, Any] | None = None,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
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
    context_items: list[AiEmbedding],
    api_key: str,
    model: str,
    frame_context: str | None = None,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
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
    context_items: list[AiEmbedding],
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
    context_block = _format_context_items(context_items)
    prompt_parts = [f"User request: {prompt}", "Current scene JSON:", json.dumps(scene, ensure_ascii=False)]
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
    context_items: list[AiEmbedding],
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
    context_block = _format_context_items(context_items)
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
    context_items: list[AiEmbedding],
    frame_context: str | None = None,
    frame_scene_summary: str | None = None,
    history: list[dict[str, str]] | None = None,
    model: str = CHAT_MODEL,
    ai_trace_id: str | None = None,
    ai_session_id: str | None = None,
    ai_parent_id: str | None = None,
) -> str:
    context_block = _format_context_items(context_items)
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
        if settings.get("execution") != "interpreted":
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
    context_items: list[AiEmbedding],
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
    context_block = _format_context_items(context_items)
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
    context_items: list[AiEmbedding],
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
    context_items: list[AiEmbedding],
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
