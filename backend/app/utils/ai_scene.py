import json
from typing import Any, Iterable

import httpx
import numpy as np

from app.models.ai_embeddings import AiEmbedding

SUMMARY_MODEL = "gpt-5-mini"
SCENE_MODEL = "gpt-5"
EMBEDDING_MODEL = "text-embedding-3-large"

SUMMARY_SYSTEM_PROMPT = """
You are summarizing FrameOS scene templates and app modules so they can be retrieved for prompt grounding.
Return JSON with keys:
- summary: 2-4 sentences describing what it does and which apps or data it uses.
- keywords: 5-10 short keywords or phrases.
Keep the summary concise and technical. Do not include markdown.
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
  - If you include a "code" node, connect its outputs to app inputs using "codeNodeEdge" with targetHandle
    "fieldInput/<fieldName>".
  - If you include scene fields, add matching "state" nodes with data.keyword = field name, and connect them via
    "codeNodeEdge" to "code" nodes using targetHandle "codeField/<argName>" or directly to app inputs using
    "fieldInput/<fieldName>".
  - If you include "scene" nodes (to embed another scene), set data.keyword to the referenced scene id and connect them
    from a layout app (like "render/split") using "appNodeEdge" with sourceHandle
    "field/render_functions[row][col]" and targetHandle "prev".
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
        lines.append(
            "\n".join(
                [
                    header,
                    f"Summary: {item.summary}",
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


def rank_embeddings(query_embedding: list[float], items: list[AiEmbedding], top_k: int = 8) -> list[AiEmbedding]:
    if not items:
        return []
    embeddings = np.array([item.embedding for item in items], dtype=float)
    scores = _cosine_similarity(np.array(query_embedding, dtype=float), embeddings)
    ranked_indices = np.argsort(scores)[::-1][:top_k]
    return [items[i] for i in ranked_indices]


async def create_embeddings(texts: list[str], api_key: str) -> list[list[float]]:
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
                    "model": EMBEDDING_MODEL,
                    "input": batch,
                },
            )
            response.raise_for_status()
            payload = response.json()
            for entry in sorted(payload.get("data", []), key=lambda item: item.get("index", 0)):
                embeddings.append(entry["embedding"])
    return embeddings


async def summarize_text(text: str, api_key: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": SUMMARY_MODEL,
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


async def generate_scene_json(
    *,
    prompt: str,
    context_items: list[AiEmbedding],
    api_key: str,
) -> dict[str, Any]:
    context_block = _format_context_items(context_items)
    user_prompt = "\n\n".join(
        [
            f"User request: {prompt}",
            "Relevant context:",
            context_block or "(no context available)",
        ]
    )
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": SCENE_MODEL,
                "messages": [
                    {"role": "system", "content": SCENE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
    content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
    return json.loads(content)
