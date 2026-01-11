import json
import re
from typing import Any, Iterable

import httpx
import numpy as np

from app.models.ai_embeddings import AiEmbedding

SUMMARY_MODEL = "gpt-5-mini"
SCENE_MODEL = "gpt-5.2"
EMBEDDING_MODEL = "text-embedding-3-large"
EXPANSION_MODEL = "gpt-5-mini"
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

EXPANSION_SYSTEM_PROMPT = """
You expand a short user request into a clearer FrameOS scene intent for retrieval.
Return JSON with keys:
- expanded_prompt: 1-3 sentences, preserving the user's intent.
Include relevant app/function hints only if they can be inferred from the request.
Do not mention embeddings or internal tools.
""".strip()

SCENE_SYSTEM_PROMPT = """
You are a FrameOS scene generator. Build scenes JSON that can be uploaded to FrameOS.
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
- State nodes are used to supply scene fields into code/app inputs: set data.keyword to the scene field name and connect
  them via codeNodeEdge with sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>" or "codeField/<argName>".
- Create edges that link the nodes into a valid flow:
  - Use "appNodeEdge" with sourceHandle "next" and targetHandle "prev" to connect the render event to the first app,
    and to connect each subsequent app node in order.
  - When an app outputs data into another app's input (e.g. data app into render/image), add a "codeNodeEdge" from
    sourceHandle "fieldOutput" to targetHandle "fieldInput/<fieldName>".
  - Data apps (like image generation) should NOT be chained into the render flow using "appNodeEdge". Instead,
    connect the render event directly to the render app (e.g. "render/image") with "appNodeEdge" and separately
    connect the data app output via "codeNodeEdge". This keeps the render flow triggered by the event.
  - If you include a "code" node, connect its outputs to app inputs using "codeNodeEdge" with targetHandle
    "fieldInput/<fieldName>".
  - If you include scene fields, add matching "state" nodes with data.keyword = field name, and connect them via
    "codeNodeEdge" to "code" nodes using targetHandle "codeField/<argName>" or directly to app inputs using
    "fieldInput/<fieldName>".
  - If you include "scene" nodes (to embed another scene), set data.keyword to the referenced scene id and connect them
    from a layout app (like "render/split") using "appNodeEdge" with sourceHandle
    "field/render_functions[row][col]" and targetHandle "prev".
- Every edge must reference nodes that exist in the "nodes" list. Do not include dangling edges.
""".strip()

SCENE_REVIEW_SYSTEM_PROMPT = """
You are a strict reviewer for FrameOS scene JSON.
Check the scene against the user request and ensure it is valid:
- It has a top-level "scenes" array with at least one scene.
- Each scene has id, name, nodes, edges, and settings.execution = "interpreted".
- There is at least one event node with data.keyword = "render".
- Every edge references existing node ids for source and target.
Respond with JSON only, using keys:
- solves: boolean (true only if the scene matches the user request)
- issues: array of short strings describing any problems
""".strip()

SCENE_FIX_SYSTEM_PROMPT = """
You fix FrameOS scene JSON based on reviewer issues.
Return only valid JSON with the same top-level format: {"title": "...", "scenes": [...]}.
Ensure all edges connect existing nodes, include render event, and keep settings.execution = "interpreted".
Do not include markdown or code fences.
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
    async with httpx.AsyncClient(timeout=60) as client:
        for batch in _chunk_texts(texts):
            response = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model or EMBEDDING_MODEL,
                    "input": batch,
                },
            )
            response.raise_for_status()
            payload = response.json()
            for entry in sorted(payload.get("data", []), key=lambda item: item.get("index", 0)):
                embeddings.append(entry["embedding"])
    return embeddings


async def summarize_text(text: str, api_key: str, *, model: str = SUMMARY_MODEL) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model or SUMMARY_MODEL,
                "messages": [
                    {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
    message = payload.get("choices", [{}])[0].get("message", {})
    content = message.get("content", "{}")
    return json.loads(content)


async def expand_prompt(prompt: str, api_key: str, *, model: str = EXPANSION_MODEL) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model or EXPANSION_MODEL,
                "messages": [
                    {"role": "system", "content": EXPANSION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
    message = payload.get("choices", [{}])[0].get("message", {})
    content = message.get("content", "{}")
    expanded = json.loads(content).get("expanded_prompt")
    if isinstance(expanded, str) and expanded.strip():
        return expanded.strip()
    return prompt


async def generate_scene_json(
    *,
    prompt: str,
    context_items: list[AiEmbedding],
    api_key: str,
    model: str,
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
    user_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
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
    payload: dict[str, Any],
    api_key: str,
    model: str = SCENE_REVIEW_MODEL,
) -> list[str]:
    review_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
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
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
    user_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            f"Reviewer issues: {json.dumps(issues, ensure_ascii=False)}",
            "Relevant context:",
            context_block or "(no context available)",
            "Previous scene JSON:",
            json.dumps(payload, ensure_ascii=False),
        ]
    )
    return await _request_scene_json(
        api_key=api_key,
        model=model,
        messages=[
            {"role": "system", "content": SCENE_FIX_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    )


async def _request_scene_json(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model or SCENE_MODEL,
                "messages": messages,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
    content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
    return json.loads(content)
