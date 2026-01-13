import json
import re
from typing import Any, Iterable

import numpy as np
from posthog.ai.openai import AsyncOpenAI

from app.models.ai_embeddings import AiEmbedding
from app.config import config
from app.utils.posthog import get_posthog_client, llm_analytics_enabled

SUMMARY_MODEL = "gpt-5-mini"
SCENE_MODEL = "gpt-5.2"
TODO_MODEL = "gpt-5.2"
EMBEDDING_MODEL = "text-embedding-3-large"
SCENE_REVIEW_MODEL = "gpt-5-mini"

DEFAULT_APP_CONTEXT_K = 6
DEFAULT_SCENE_CONTEXT_K = 4
DEFAULT_MIN_SCORE = 0.15
MMR_LAMBDA = 0.7

SUMMARY_SYSTEM_PROMPT = """
You are summarizing FrameOS scene templates and app modules so they can be retrieved for prompt grounding.
Return JSON with keys:
- summary: 2-4 sentences describing what it does and which apps or data it uses.
- keywords: 5-10 short keywords or phrases.
Keep the summary concise and technical. Do not include markdown.
""".strip()

TODO_SYSTEM_PROMPT = """
You are a FrameOS scene builder. Create a concise, agentic todo list to build the scene.
Return JSON only with keys:
- title: short title
- todos: array of 6-10 short todo items (imperative phrasing).
The todo list must explicitly include tasks for:
- deciding which apps or nodes are most needed for the user request
- following the FrameOS scene rules/format
- producing the final scenes JSON
- validating the output and fixing issues
""".strip()

SCENE_JSON_SYSTEM_PROMPT = """
You are a FrameOS scene generator. Build scenes JSON that can be uploaded to FrameOS.
You will receive a todo list; follow it step by step while you work.
Follow these rules:
- Output a JSON object with a top-level "title" string and "scenes" array. No markdown or code fences.
- Each scene must include: id (string), name (string), nodes (array), edges (array).
- Each scene must include settings.execution = "interpreted" (never "compiled").
- Each node must include: id (string), type (see below), data (object).
- App node configs belong under data.config, not directly on data.
- Supported node types in examples: "event", "app", "state", "code", "scene".
- Include at least one event node with data.keyword = "render" to trigger rendering.
- Use ONLY app keywords from the provided context. If none match, use "render/text" and a simple message.
- Prefer minimal but valid configs; omit fields when not needed.
- Keep node positions optional; if provided, use simple x/y numbers.
- Available data field types: string, text, float, integer, boolean, color, date, json, node, scene, image, font, select.
- Ensure number types match: connect floats to float fields and integers to integer fields; do not mix numeric types.
- When defining scene fields, set access = "public" and persist = "disk" unless there is a specific reason not to. This way users can modify them.
- Text apps can render rich text using the simple caret syntax (basic-caret) to display dynamic text.
  Use caret tokens like ^(16) for font size, ^(#FF00FF) for color, ^(PTSans-Bold.ttf) for font,
  ^(underline)/^(no-underline), ^(strikethrough)/^(no-strikethrough), combine styles via ^(16,#FF0000),
  and reset styles with ^(reset).
- State nodes are used to supply scene fields into code/app inputs: set data.keyword to the scene field name and connect
  them via codeNodeEdge with sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>" or "codeField/<argName>".
- Create edges that link the nodes into a valid flow:
  - Use "appNodeEdge" with sourceHandle "next" and targetHandle "prev" to connect the render event to the first app,
    and to connect each subsequent app node in order.
  - Do not connect multiple "next" edges to the same "prev" handle. The render flow must be a single linear chain
    where each app node connects to exactly one next node in sequence.
  - Only apps with category "logic" or "render" can be connected left/right using appNodeEdge. Apps with category
    "data" must not be connected left/right and must only connect via field outputs into inputs.
  - When an app outputs data into another app's input (e.g. data app into render/image), add a "codeNodeEdge" from
    sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>".
  - Every app node must be connected either through the render flow (prev/next) or via a field output/input edge.
- Data apps (like image generation) should NOT be chained into the render flow using "appNodeEdge". Instead,
    connect the render event directly to the render app (e.g. "render/image") with "appNodeEdge" and separately
    connect the data app output via "codeNodeEdge". This keeps the render flow triggered by the event.
  - Never store an image output node as state in JSON; pass image outputs directly into app inputs via codeNodeEdge.
  - If you include an OpenAI image app (keyword "data/openaiImage" or legacy "openai"), enable cache with
    duration "3600" (one hour) and do not set scene refreshInterval below 3600 unless the user explicitly
    asks for a faster update cadence.
  - If you include a "code" node, connect its outputs to app inputs using "codeNodeEdge" with targetHandle
    "fieldInput/<fieldName>".
  - If you include scene fields, add matching "state" nodes with data.keyword = field name, and connect them via
    "codeNodeEdge" to "code" nodes using targetHandle "codeField/<argName>" or directly to app inputs using
    "fieldInput/<fieldName>".
  - Code nodes can be added anywhere for most fields (see "Haiku of the hour" for an example); only data.codeJS
    needs to be filled in for interpreted scenes.
  - If you include "scene" nodes (to embed another scene), set data.keyword to the referenced scene id and connect them
    from a layout app (like "render/split") using "appNodeEdge" with sourceHandle
    "field/render_functions[row][col]" and targetHandle "prev".
- Every edge must reference nodes that exist in the "nodes" list. Do not include dangling edges.
- Every state field must include a default value in the "value" field as a stringified version of itself.
- Interpreted scenes can include quick JavaScript snippets in code nodes:
  - Put JS in data.codeJS (not data.code) for interpreted scenes.
  - The QuickJS environment exposes: state.<field>, args.<argName>, context.<event|payload|loopIndex|loopKey|hasImage>.
  - Console logging is available via console.log/warn/error.
  - Time helpers: parseTs(format, text), format(timestamp, format), now().
  - Keep snippets as expressions that return a value (e.g. "state.title ?? 'Hello'" or "args.url").
Reference TypeScript shapes (for structure sanity):
- Scene: { id: string, name: string, nodes: Node[], edges: Edge[], settings: { execution: "interpreted", ... }, fields?: Field[] }
- Node: { id: string, type: "event"|"app"|"state"|"code"|"scene", data: NodeData, position?: { x:number, y:number } }
- Edge: { id?: string, type?: "appNodeEdge"|"codeNodeEdge", source: string, target: string, sourceHandle?: string, targetHandle?: string }
- Field: { name: string, type: FieldType, label?: string, description?: string, required?: boolean, value?: any }
- NodeData:
  - EventNodeData: { keyword: string }
  - AppNodeData: { keyword: string, config: object, sources?: object, cache?: object }
  - StateNodeData: { keyword: string }
  - CodeNodeData: { codeJS?: string, code?: string, codeArgs?: { name: string, type: FieldType }[], codeOutputs?: { name: string, type: FieldType }[], cache?: object, logOutput?: boolean }
  - SceneNodeData: { keyword: string, config: object }
- FieldType: "string"|"text"|"float"|"integer"|"boolean"|"color"|"date"|"json"|"node"|"scene"|"image"|"font"|"select"
Use any relevant scene examples from the provided context as guidance.
""".strip()

SCENE_REVIEW_SYSTEM_PROMPT = """
You are a strict reviewer for FrameOS scene JSON.
Check the scene against the user request and ensure it is valid:
- It has a top-level "scenes" array with at least one scene.
- Each scene has id, name, nodes, edges, and settings.execution = "interpreted".
- There is at least one event node with data.keyword = "render".
- Every edge references existing node ids for source and target.
- Every logic and render app node is connected via prev/next or a field output/input edge.
- All state fields include a default "value" field which is a string.
- The render flow does not branch: no multiple "next" edges point to the same "prev" handle.
- No image output is stored as state in JSON; image outputs must be wired directly into app inputs.
Respond with JSON only, using keys:
- solves: boolean (true only if the scene matches the user request)
- issues: array of short strings describing any problems
""".strip()

DEFAULT_TODO_LIST = [
    "Extract the core user intent and constraints.",
    "Decide which apps/nodes are most needed for the request.",
    "Map the render flow and data flow according to FrameOS rules.",
    "Assemble the scene nodes/edges using the required formats.",
    "Produce the final scenes JSON response.",
    "Validate the JSON against required scene rules and fix issues.",
]


def _chunk_texts(texts: Iterable[str], batch_size: int = 64) -> Iterable[list[str]]:
    batch: list[str] = []
    for text in texts:
        batch.append(text)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def _format_context_items(items: list[AiEmbedding]) -> str:
    lines: list[str] = []
    for item in items:
        metadata = item.metadata_json or {}
        header = f"[{item.source_type}] {item.name or item.source_path}"
        keyword_list = metadata.get("keywords") or []
        app_keywords = metadata.get("appKeywords") or []
        event_keywords = metadata.get("eventKeywords") or []
        node_types = metadata.get("nodeTypes") or []
        fields = metadata.get("fieldDetails") or metadata.get("fields") or []
        outputs = metadata.get("outputDetails") or metadata.get("outputs") or []
        preview_nodes = metadata.get("previewNodes") or []
        config_snippet = metadata.get("configSnippet")
        lines.append(
            "\n".join(
                [
                    header,
                    f"Summary: {item.summary}",
                    f"Keywords: {', '.join(keyword_list)}" if keyword_list else "Keywords: (none)",
                    f"App keywords: {', '.join(app_keywords)}" if app_keywords else "App keywords: (none)",
                    f"Event keywords: {', '.join(event_keywords)}" if event_keywords else "Event keywords: (none)",
                    f"Node types: {', '.join(node_types)}" if node_types else "Node types: (none)",
                    f"Fields: {json.dumps(fields, ensure_ascii=False)}" if fields else "Fields: (none)",
                    f"Outputs: {json.dumps(outputs, ensure_ascii=False)}" if outputs else "Outputs: (none)",
                    f"Preview nodes: {json.dumps(preview_nodes, ensure_ascii=False)}"
                    if preview_nodes
                    else "Preview nodes: (none)",
                    f"Config snippet: {config_snippet}" if config_snippet else "Config snippet: (none)",
                    f"Metadata: {json.dumps(metadata, ensure_ascii=False)}",
                ]
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


def _openai_client(api_key: str, *, timeout: float) -> AsyncOpenAI:
    posthog_client = get_posthog_client() if llm_analytics_enabled() else None
    return AsyncOpenAI(
        api_key=api_key,
        posthog_client=posthog_client,
        timeout=timeout,
    )


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


async def create_embeddings(texts: list[str], api_key: str, model: str) -> list[list[float]]:
    embeddings: list[list[float]] = []
    client = _openai_client(api_key, timeout=60)
    for batch in _chunk_texts(texts):
        response = await client.embeddings.create(
            model=model or EMBEDDING_MODEL,
            input=batch,
            posthog_distinct_id=config.INSTANCE_ID,
            posthog_properties={
                "operation": "create_embeddings",
                "model": model or EMBEDDING_MODEL,
                "input_count": len(batch),
            },
        )
        for entry in sorted(response.data, key=lambda item: item.index):
            embeddings.append(entry.embedding)
    return embeddings


async def summarize_text(text: str, api_key: str, *, model: str = SUMMARY_MODEL) -> dict[str, Any]:
    client = _openai_client(api_key, timeout=60)
    response = await client.chat.completions.create(
        model=model or SUMMARY_MODEL,
        messages=[
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties={
            "operation": "summarize_text",
            "model": model or SUMMARY_MODEL,
        },
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)


def _ensure_required_todos(todos: list[str]) -> list[str]:
    normalized = [todo.strip() for todo in todos if isinstance(todo, str) and todo.strip()]
    required_items = {
        "apps": "Decide which apps/nodes are most needed for the request.",
        "rules": "Follow the FrameOS scene rules and format strictly.",
        "json": "Produce the final scenes JSON response.",
        "validate": "Validate the JSON and fix any issues.",
    }
    missing = []
    lowered = " ".join(normalized).lower()
    if "app" not in lowered and "node" not in lowered:
        missing.append(required_items["apps"])
    if "rule" not in lowered and "format" not in lowered:
        missing.append(required_items["rules"])
    if "json" not in lowered:
        missing.append(required_items["json"])
    if "valid" not in lowered and "review" not in lowered:
        missing.append(required_items["validate"])
    return [*normalized, *missing] if missing else normalized


async def create_scene_todo_list(
    *,
    prompt: str,
    context_items: list[AiEmbedding],
    api_key: str,
    model: str = TODO_MODEL,
) -> list[str]:
    context_block = _format_context_items(context_items)
    todo_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    response = await _request_scene_json(
        api_key=api_key,
        model=model or TODO_MODEL,
        messages=[
            {"role": "system", "content": TODO_SYSTEM_PROMPT},
            {"role": "user", "content": todo_prompt},
        ],
        context_items=context_items,
    )
    todos = response.get("todos")
    if isinstance(todos, list) and todos:
        return _ensure_required_todos(todos)
    return DEFAULT_TODO_LIST.copy()


async def generate_scene_json(
    *,
    prompt: str,
    todo_list: list[str],
    context_items: list[AiEmbedding],
    api_key: str,
    model: str,
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
    scene_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            "Todo list:",
            json.dumps(todo_list, ensure_ascii=False),
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_JSON_SYSTEM_PROMPT},
            {"role": "user", "content": scene_prompt},
        ],
        context_items=context_items,
    )


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
    todo_list: list[str],
    payload: dict[str, Any],
    api_key: str,
    model: str = SCENE_REVIEW_MODEL,
) -> list[str]:
    review_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            "Todo list:",
            json.dumps(todo_list, ensure_ascii=False),
            "Scene JSON:",
            json.dumps(payload, ensure_ascii=False),
        ]
    )
    response = await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": review_prompt},
        ],
        context_items=[],
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
    todo_list: list[str],
    context_items: list[AiEmbedding],
    api_key: str,
    model: str,
    payload: dict[str, Any],
    issues: list[str],
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
    scene_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            f"Reviewer issues: {json.dumps(issues, ensure_ascii=False)}",
            "Todo list:",
            json.dumps(todo_list, ensure_ascii=False),
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_JSON_SYSTEM_PROMPT},
            {"role": "user", "content": scene_prompt},
        ],
        context_items=context_items,
    )


async def _request_scene_json(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    context_items: list[AiEmbedding],
) -> dict[str, Any]:
    client = _openai_client(api_key, timeout=90)
    response = await client.chat.completions.create(
        model=model or SCENE_MODEL,
        messages=messages,
        response_format={"type": "json_object"},
        posthog_distinct_id=config.INSTANCE_ID,
        posthog_properties={
            "operation": "generate_scene_json",
            "model": model or SCENE_MODEL,
            "context_items": len(context_items),
        },
    )
    message = response.choices[0].message if response.choices else None
    content = message.content if message else "{}"
    return json.loads(content)
