import copy
from http import HTTPStatus
from datetime import datetime
from pathlib import Path
from uuid import uuid4
import re
import time
import json
from typing import Any
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.models.ai_embeddings import AiEmbedding
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.schemas.ai_scenes import (
    AiSceneGenerateRequest,
    AiSceneGenerateResponse,
    AiSceneContextItem,
    AiSceneChatRequest,
    AiSceneChatResponse,
)
from app.config import config
from app.utils.ai_scene import (
    CHAT_MODEL,
    EMBEDDING_MODEL,
    SCENE_MODEL,
    SCENE_REVIEW_MODEL,
    PROMPT_EXPANSION_MODEL,
    DEFAULT_APP_CONTEXT_K,
    DEFAULT_SCENE_CONTEXT_K,
    create_embeddings,
    expand_scene_prompt,
    format_frame_context,
    format_frame_scene_summary,
    generate_scene_json,
    generate_scene_plan,
    repair_scene_json,
    modify_scene_json,
    route_scene_chat,
    answer_frame_question,
    answer_scene_question,
    rank_embeddings,
    review_scene_solution,
    validate_scene_payload,
)
from app.models.frame import Frame
from app.utils.posthog import get_posthog_client, llm_analytics_enabled
from app.websockets import publish_message
from . import api_with_auth

AI_ID_PATTERN = re.compile(r"[^A-Za-z0-9\\-_.@()!'~:|]")
REQUIRED_EMBEDDING_PATHS = {
    "frameos/src/apps/render/image",
    "frameos/src/apps/render/text",
    "frameos/src/apps/render/split",
    "frameos/src/apps/render/svg",
    "frameos/src/apps/logic/setAsState",
    "repo/scenes/samples/XKCD",
    "repo/scenes/samples/Split agenda",
}

SERVICE_SECRET_FIELDS: dict[str, dict[str, Any]] = {
    "openAI": {"fields": ("apiKey",)},
    "unsplash": {"fields": ("accessKey",)},
    "homeAssistant": {"fields": ("accessToken",)},
    "github": {"fields": ("api_key",), "free_limited_usage": True},
}


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _get_missing_service_keys(settings: dict[str, Any]) -> set[str]:
    missing: set[str] = set()
    for service_key, details in SERVICE_SECRET_FIELDS.items():
        fields = details.get("fields", ())
        service_settings = settings.get(service_key) or {}
        if any(not _has_value(service_settings.get(field)) for field in fields):
            missing.add(service_key)
    return missing


def _filter_embeddings_for_services(embeddings: list[AiEmbedding], missing_service_keys: set[str]) -> list[AiEmbedding]:
    filtered: list[AiEmbedding] = []
    for item in embeddings:
        if item.source_type != "app":
            filtered.append(item)
            continue
        metadata = item.metadata_json or {}
        required_settings = metadata.get("settings")
        if not isinstance(required_settings, list):
            config_path = metadata.get("configPath")
            if config_path:
                try:
                    config_data = json.loads((Path(__file__).resolve().parents[3] / config_path).read_text("utf-8"))
                    required_settings = config_data.get("settings") or []
                except Exception:
                    required_settings = []
            else:
                required_settings = []
        if any(
            setting in missing_service_keys and not SERVICE_SECRET_FIELDS.get(setting, {}).get("free_limited_usage")
            for setting in required_settings
        ):
            continue
        filtered.append(item)
    return filtered


def _ensure_required_embeddings(
    ranked_items: list[AiEmbedding],
    available_embeddings: list[AiEmbedding],
) -> list[AiEmbedding]:
    required_items = [
        item
        for item in available_embeddings
        if item.source_path in REQUIRED_EMBEDDING_PATHS
    ]
    existing_keys = {(item.source_type, item.source_path) for item in ranked_items}
    missing_items = [
        item for item in required_items if (item.source_type, item.source_path) not in existing_keys
    ]
    if not missing_items:
        return ranked_items
    return [*missing_items, *ranked_items]


def _sanitize_ai_id(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = AI_ID_PATTERN.sub("_", value)
    return cleaned or None


def _capture_ai_span(
    *,
    trace_id: str | None,
    session_id: str | None,
    span_id: str | None,
    parent_id: str | None,
    span_name: str | None,
    latency: float | None,
) -> None:
    posthog_client = get_posthog_client()
    if posthog_client is None or not llm_analytics_enabled() or not trace_id or not span_id:
        return
    properties = {
        "$ai_trace_id": _sanitize_ai_id(trace_id),
        "$ai_session_id": _sanitize_ai_id(session_id),
        "$ai_span_id": _sanitize_ai_id(span_id),
        "$ai_parent_id": _sanitize_ai_id(parent_id),
        "$ai_span_name": span_name,
        "$ai_latency": latency,
    }
    properties = {key: value for key, value in properties.items() if value is not None}
    try:
        posthog_client.capture(
            distinct_id=config.INSTANCE_ID,
            event="$ai_span",
            properties=properties,
        )
    except Exception:
        pass


def _capture_ai_trace(
    *,
    trace_id: str | None,
    session_id: str | None,
    input_state: list[dict[str, str]],
    output_state: dict[str, Any],
) -> None:
    posthog_client = get_posthog_client()
    if posthog_client is None or not llm_analytics_enabled() or not trace_id:
        return
    properties = {
        "$ai_trace_id": _sanitize_ai_id(trace_id),
        "$ai_session_id": _sanitize_ai_id(session_id),
        "$ai_input_state": input_state,
        "$ai_output_state": output_state,
    }
    properties = {key: value for key, value in properties.items() if value is not None}
    try:
        posthog_client.capture(
            distinct_id=config.INSTANCE_ID,
            event="$ai_trace",
            properties=properties,
        )
    except Exception:
        pass


def _split_state_nodes_by_app(payload: dict[str, Any]) -> None:
    scenes = payload.get("scenes")
    if not isinstance(scenes, list):
        return

    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        nodes = scene.get("nodes")
        edges = scene.get("edges")
        if not isinstance(nodes, list) or not isinstance(edges, list):
            continue

        node_by_id = {
            node.get("id"): node
            for node in nodes
            if isinstance(node, dict) and isinstance(node.get("id"), str)
        }
        app_ids = {node_id for node_id, node in node_by_id.items() if node.get("type") == "app"}
        state_ids = {node_id for node_id, node in node_by_id.items() if node.get("type") == "state"}
        if not app_ids or not state_ids:
            continue

        edges_by_state: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            source = edge.get("source")
            target = edge.get("target")
            if source in state_ids and target in app_ids:
                edges_by_state.setdefault(str(source), {}).setdefault(str(target), []).append(edge)

        if not edges_by_state:
            continue

        new_nodes: list[dict[str, Any]] = []
        nodes_to_remove: set[str] = set()
        for state_id, app_edges in edges_by_state.items():
            if len(app_edges) <= 1:
                continue
            state_node = node_by_id.get(state_id)
            if not state_node:
                continue
            for app_id, app_edge_list in app_edges.items():
                new_id = str(uuid4())
                new_node = copy.deepcopy(state_node)
                new_node["id"] = new_id
                new_nodes.append(new_node)
                for edge in app_edge_list:
                    edge["source"] = new_id
            nodes_to_remove.add(state_id)

        if nodes_to_remove:
            for state_id in list(nodes_to_remove):
                if any(
                    isinstance(edge, dict) and edge.get("source") == state_id
                    for edge in edges
                ):
                    nodes_to_remove.discard(state_id)
            if nodes_to_remove:
                nodes = [
                    node
                    for node in nodes
                    if not (isinstance(node, dict) and node.get("id") in nodes_to_remove)
                ]
                scene["nodes"] = nodes

        if new_nodes:
            scene.setdefault("nodes", []).extend(new_nodes)


async def _publish_ai_scene_log(
    redis: Redis,
    message: str,
    request_id: str,
    status: str = "info",
    stage: str | None = None,
) -> None:
    await publish_message(
        redis,
        "ai_scene_log",
        {
            "message": message,
            "requestId": request_id,
            "status": status,
            "stage": stage,
            "timestamp": datetime.utcnow().isoformat(),
        },
    )


async def _load_context_items(
    *,
    db: Session,
    settings: dict[str, Any],
    api_key: str,
    prompt: str,
    ai_trace_id: str | None,
    ai_session_id: str | None,
    ai_parent_id: str | None,
) -> list[AiEmbedding]:
    embeddings = db.query(AiEmbedding).all()
    if not embeddings:
        return []
    missing_service_keys = _get_missing_service_keys(settings)
    available_embeddings = _filter_embeddings_for_services(embeddings, missing_service_keys)
    if not available_embeddings:
        return []
    openai_settings = settings.get("openAI", {})
    query_embedding = (
        await create_embeddings(
            [prompt],
            api_key,
            model=openai_settings.get("embeddingModel") or EMBEDDING_MODEL,
            ai_trace_id=ai_trace_id,
            ai_session_id=ai_session_id,
            ai_parent_id=ai_parent_id,
        )
    )[0]
    app_embeddings = [item for item in available_embeddings if item.source_type == "app"]
    scene_embeddings = [item for item in available_embeddings if item.source_type == "scene"]
    ranked_items = [
        *rank_embeddings(
            query_embedding,
            app_embeddings,
            prompt=prompt,
            top_k=DEFAULT_APP_CONTEXT_K,
        ),
        *rank_embeddings(
            query_embedding,
            scene_embeddings,
            prompt=prompt,
            top_k=DEFAULT_SCENE_CONTEXT_K,
        ),
    ]
    ranked_items = _ensure_required_embeddings(ranked_items, available_embeddings)
    seen: set[tuple[str, str]] = set()
    context_items: list[AiEmbedding] = []
    for item in ranked_items:
        key = (item.source_type, item.source_path)
        if key in seen:
            continue
        seen.add(key)
        context_items.append(item)
    return context_items


@api_with_auth.post("/ai/scenes/generate", response_model=AiSceneGenerateResponse)
async def generate_scene(
    data: AiSceneGenerateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    request_id = data.request_id or str(uuid4())
    posthog_trace_id = _sanitize_ai_id(request_id) or str(uuid4())
    posthog_session_id = None
    posthog_root_span_id = str(uuid4())
    generation_start = time.perf_counter()
    await _publish_ai_scene_log(redis, "Starting AI scene generation.", request_id, stage="start")
    prompt = data.prompt.strip()
    if not prompt:
        await _publish_ai_scene_log(
            redis,
            "Prompt is required to generate a scene.",
            request_id,
            status="error",
            stage="validate",
        )
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Prompt is required")

    frame_context = None
    if data.frame_id is not None:
        frame = db.query(Frame).filter(Frame.id == data.frame_id).first()
        if frame:
            frame_context = format_frame_context(
                {
                    "name": frame.name,
                    "width": frame.width,
                    "height": frame.height,
                    "device": frame.device,
                    "color": frame.color,
                    "background_color": frame.background_color,
                    "scaling_mode": frame.scaling_mode,
                    "rotate": frame.rotate,
                    "flip": frame.flip,
                    "gpio_buttons": frame.gpio_buttons,
                }
            )
        else:
            await _publish_ai_scene_log(
                redis,
                f"Frame {data.frame_id} not found; generating without frame context.",
                request_id,
                status="warning",
                stage="frame:skip",
            )

    settings = get_settings_dict(db)
    openai_settings = settings.get("openAI", {})
    api_key = openai_settings.get("backendApiKey")
    if not api_key:
        await _publish_ai_scene_log(
            redis,
            "OpenAI backend API key not set.",
            request_id,
            status="error",
            stage="validate",
        )
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI backend API key not set")

    try:
        expanded_prompt = prompt
        expansion_keywords: list[str] = []
        prompt_for_retrieval = prompt
        try:
            await _publish_ai_scene_log(redis, "Expanding prompt for retrieval.", request_id, stage="prompt:expand")
            expansion = await expand_scene_prompt(
                prompt=prompt,
                api_key=api_key,
                model=openai_settings.get("promptExpansionModel") or PROMPT_EXPANSION_MODEL,
                frame_context=frame_context,
                ai_trace_id=posthog_trace_id,
                ai_session_id=posthog_session_id,
                ai_parent_id=posthog_root_span_id,
            )
            candidate_prompt = expansion.get("expanded_prompt")
            if isinstance(candidate_prompt, str) and candidate_prompt.strip():
                expanded_prompt = candidate_prompt.strip()

            candidate_keywords = expansion.get("keywords")
            if isinstance(candidate_keywords, list):
                expansion_keywords = [str(item).strip() for item in candidate_keywords if str(item).strip()]
            prompt_for_retrieval = expanded_prompt
            if expansion_keywords:
                prompt_for_retrieval = f"{expanded_prompt}\nKeywords: {', '.join(expansion_keywords)}"
        except Exception as exc:
            await _publish_ai_scene_log(
                redis,
                f"Prompt expansion failed; continuing with original prompt. ({exc})",
                request_id,
                status="warning",
                stage="prompt:expand",
            )
            prompt_for_retrieval = prompt

        await _publish_ai_scene_log(redis, "Loading embeddings.", request_id, stage="context:load")
        embeddings = db.query(AiEmbedding).all()
        missing_service_keys = _get_missing_service_keys(settings)
        available_embeddings = _filter_embeddings_for_services(embeddings, missing_service_keys)
        context_items: list[AiEmbedding] = []
        if available_embeddings:
            await _publish_ai_scene_log(redis, "Creating retrieval embedding.", request_id, stage="context:embed")
            query_embedding = (
                await create_embeddings(
                    [prompt_for_retrieval],
                    api_key,
                    model=openai_settings.get("embeddingModel") or EMBEDDING_MODEL,
                    ai_trace_id=posthog_trace_id,
                    ai_session_id=posthog_session_id,
                    ai_parent_id=posthog_root_span_id,
                )
            )[0]
            app_embeddings = [item for item in available_embeddings if item.source_type == "app"]
            scene_embeddings = [item for item in available_embeddings if item.source_type == "scene"]
            await _publish_ai_scene_log(redis, "Ranking relevant context.", request_id, stage="context:rank")
            ranked_items = [
                *rank_embeddings(
                    query_embedding,
                    app_embeddings,
                    prompt=prompt_for_retrieval,
                    top_k=DEFAULT_APP_CONTEXT_K,
                ),
                *rank_embeddings(
                    query_embedding,
                    scene_embeddings,
                    prompt=prompt_for_retrieval,
                    top_k=DEFAULT_SCENE_CONTEXT_K,
                ),
            ]
            ranked_items = _ensure_required_embeddings(ranked_items, available_embeddings)
            seen: set[tuple[str, str]] = set()
            context_items = []
            context_items_strings = []
            for item in ranked_items:
                key = (item.source_type, item.source_path)
                if key in seen:
                    continue
                seen.add(key)
                context_items.append(item)
                context_items_strings.append(f"[{item.source_type}] {item.source_path}")
            await _publish_ai_scene_log(
                redis,
                f"Selected {len(context_items)} context items: {', '.join(context_items_strings)}",
                request_id,
                stage="context:ready",
            )
        elif embeddings:
            await _publish_ai_scene_log(
                redis,
                "No embeddings available after filtering unavailable services; generating without retrieval context.",
                request_id,
                stage="context:skip",
            )
        else:
            await _publish_ai_scene_log(
                redis,
                "No embeddings found; generating without retrieval context.",
                request_id,
                stage="context:skip",
            )

        response_payload: dict[str, Any] | None = None
        scene_plan: dict[str, Any] | None = None
        validation_issues: list[str] = []
        review_issues: list[str] = []
        max_attempts = 3
        scene_model = openai_settings.get("sceneModel") or SCENE_MODEL
        review_model = openai_settings.get("reviewModel") or SCENE_REVIEW_MODEL
        await _publish_ai_scene_log(redis, "Generating scene plan.", request_id, stage="plan")
        scene_plan = await generate_scene_plan(
            prompt=prompt,
            context_items=context_items,
            api_key=api_key,
            model=scene_model,
            frame_context=frame_context,
            ai_trace_id=posthog_trace_id,
            ai_session_id=posthog_session_id,
            ai_parent_id=posthog_root_span_id,
        )
        for attempt in range(1, max_attempts + 1):
            if attempt == 1:
                await _publish_ai_scene_log(
                    redis,
                    "Generating scene JSON.",
                    request_id,
                    stage="generate",
                )
                response_payload = await generate_scene_json(
                    prompt=prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                    plan=scene_plan,
                    frame_context=frame_context,
                    ai_trace_id=posthog_trace_id,
                    ai_session_id=posthog_session_id,
                    ai_parent_id=posthog_root_span_id,
                )
            else:
                await _publish_ai_scene_log(
                    redis,
                    "Fixing scene JSON.",
                    request_id,
                    stage="generate",
                )
                response_payload = await repair_scene_json(
                    prompt=prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                    payload=response_payload or {},
                    issues=validation_issues + review_issues,
                    plan=scene_plan,
                    frame_context=frame_context,
                    ai_trace_id=posthog_trace_id,
                    ai_session_id=posthog_session_id,
                    ai_parent_id=posthog_root_span_id,
                )

            validation_issues = validate_scene_payload(response_payload or {})
            if validation_issues:
                await _publish_ai_scene_log(
                    redis,
                    f"Scene validation issues: {validation_issues}",
                    request_id,
                    status="warning",
                    stage="validate",
                )
            if validation_issues:
                continue

            review_issues = await review_scene_solution(
                prompt=prompt,
                payload=response_payload or {},
                api_key=api_key,
                model=review_model,
                frame_context=frame_context,
                ai_trace_id=posthog_trace_id,
                ai_session_id=posthog_session_id,
                ai_parent_id=posthog_root_span_id,
            )
            if review_issues:
                await _publish_ai_scene_log(
                    redis,
                    f"Scene review issues: {review_issues}",
                    request_id,
                    status="warning",
                    stage="validate",
                )
                continue
            break

        if validation_issues or review_issues:
            issue_summary = {
                "validation": validation_issues,
                "review": review_issues,
            }
            await _publish_ai_scene_log(
                redis,
                "AI scene generation did not pass validation after retries. Saving anyway; please fix the issues.",
                request_id,
                status="warning",
                stage="validate",
            )
            await _publish_ai_scene_log(
                redis,
                f"Issues: {issue_summary}",
                request_id,
                status="warning",
                stage="validate",
            )
    except HTTPException:
        raise
    except Exception as exc:
        await _publish_ai_scene_log(
            redis,
            f"AI scene generation failed: {exc}",
            request_id,
            status="error",
            stage="error",
        )
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"AI scene generation failed: {exc}",
        ) from exc

    title = response_payload.get("title") if response_payload else "Untitled Scene"
    scenes = response_payload.get("scenes") if response_payload else None
    if not isinstance(scenes, list):
        await _publish_ai_scene_log(
            redis,
            f"AI response did not include scenes (got {type(scenes).__name__}).",
            request_id,
            status="error",
            stage="validate",
        )
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"AI response did not include scenes (got {type(scenes).__name__}).",
        )

    if response_payload:
        _split_state_nodes_by_app(response_payload)

    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        settings: dict[str, Any] | None = scene.get("settings") or {}
        if not isinstance(settings, dict):
            settings = {}
            scene["settings"] = settings
        settings["prompt"] = prompt

    context_response = [
        AiSceneContextItem(
            source_type=item.source_type,
            source_path=item.source_path,
            name=item.name,
            summary=item.summary,
            metadata=item.metadata_json,
        )
        for item in context_items
    ]

    await _publish_ai_scene_log(redis, "Scene generation complete.", request_id, status="success", stage="done")

    _capture_ai_trace(
        trace_id=posthog_trace_id,
        session_id=posthog_session_id,
        input_state=[{"role": "user", "content": prompt}],
        output_state={"title": title, "scenes": scenes},
    )
    _capture_ai_span(
        trace_id=posthog_trace_id,
        session_id=posthog_session_id,
        span_id=posthog_root_span_id,
        parent_id=None,
        span_name="ai_scene_generation",
        latency=time.perf_counter() - generation_start,
    )

    return AiSceneGenerateResponse(title=title, scenes=scenes, context=context_response)


@api_with_auth.post("/ai/scenes/chat", response_model=AiSceneChatResponse)
async def chat_scene(
    data: AiSceneChatRequest,
    db: Session = Depends(get_db),
):
    request_id = data.request_id or str(uuid4())
    posthog_trace_id = _sanitize_ai_id(request_id) or str(uuid4())
    posthog_session_id = None
    posthog_root_span_id = str(uuid4())
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Prompt is required")

    frame_context = None
    frame_scene_summary = None
    if data.frame_id is not None:
        frame = db.query(Frame).filter(Frame.id == data.frame_id).first()
        if frame:
            frame_context = format_frame_context(
                {
                    "name": frame.name,
                    "width": frame.width,
                    "height": frame.height,
                    "device": frame.device,
                    "color": frame.color,
                    "background_color": frame.background_color,
                    "scaling_mode": frame.scaling_mode,
                    "rotate": frame.rotate,
                    "flip": frame.flip,
                    "gpio_buttons": frame.gpio_buttons,
                }
            )
            frame_scene_summary = format_frame_scene_summary(frame.scenes)

    settings = get_settings_dict(db)
    openai_settings = settings.get("openAI", {})
    api_key = openai_settings.get("backendApiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI backend API key not set")

    history = [item.model_dump() for item in (data.history or [])]
    scene_payload = data.scene if isinstance(data.scene, dict) else None
    tool_payload = await route_scene_chat(
        prompt=prompt,
        scene=scene_payload,
        frame_context=frame_context,
        history=history,
        api_key=api_key,
        model=openai_settings.get("chatModel") or CHAT_MODEL,
        ai_trace_id=posthog_trace_id,
        ai_session_id=posthog_session_id,
        ai_parent_id=posthog_root_span_id,
    )

    tool = tool_payload.get("tool") if isinstance(tool_payload, dict) else None
    tool_prompt = tool_payload.get("tool_prompt") if isinstance(tool_payload, dict) else None
    if not isinstance(tool_prompt, str) or not tool_prompt.strip():
        tool_prompt = prompt
    tool = tool if tool in {"build_scene", "modify_scene", "answer_frame_question", "answer_scene_question", "reply"} else "answer_frame_question"
    if tool == "modify_scene" and not scene_payload:
        tool = "answer_frame_question"
    if tool == "answer_scene_question" and not scene_payload:
        tool = "answer_frame_question"

    context_items = await _load_context_items(
        db=db,
        settings=settings,
        api_key=api_key,
        prompt=tool_prompt,
        ai_trace_id=posthog_trace_id,
        ai_session_id=posthog_session_id,
        ai_parent_id=posthog_root_span_id,
    )

    selected_nodes = data.selected_nodes if isinstance(data.selected_nodes, list) else None
    selected_edges = data.selected_edges if isinstance(data.selected_edges, list) else None

    if tool in {"answer_scene_question", "reply"} and scene_payload:
        answer = await answer_scene_question(
            prompt=tool_prompt,
            api_key=api_key,
            context_items=context_items,
            frame_context=frame_context,
            scene=scene_payload,
            selected_nodes=selected_nodes,
            selected_edges=selected_edges,
            history=history,
            model=openai_settings.get("chatModel") or CHAT_MODEL,
            ai_trace_id=posthog_trace_id,
            ai_session_id=posthog_session_id,
            ai_parent_id=posthog_root_span_id,
        )
        return AiSceneChatResponse(reply=answer, tool=tool)

    if tool in {"answer_frame_question", "reply"}:
        answer = await answer_frame_question(
            prompt=tool_prompt,
            api_key=api_key,
            context_items=context_items,
            frame_context=frame_context,
            frame_scene_summary=frame_scene_summary,
            history=history,
            model=openai_settings.get("chatModel") or CHAT_MODEL,
            ai_trace_id=posthog_trace_id,
            ai_session_id=posthog_session_id,
            ai_parent_id=posthog_root_span_id,
        )
        return AiSceneChatResponse(reply=answer, tool=tool)

    if tool == "build_scene":
        response_payload: dict[str, Any] | None = None
        scene_plan: dict[str, Any] | None = None
        validation_issues: list[str] = []
        review_issues: list[str] = []
        max_attempts = 3
        scene_model = openai_settings.get("sceneModel") or SCENE_MODEL
        review_model = openai_settings.get("reviewModel") or SCENE_REVIEW_MODEL
        scene_plan = await generate_scene_plan(
            prompt=tool_prompt,
            context_items=context_items,
            api_key=api_key,
            model=scene_model,
            frame_context=frame_context,
            ai_trace_id=posthog_trace_id,
            ai_session_id=posthog_session_id,
            ai_parent_id=posthog_root_span_id,
        )
        for attempt in range(1, max_attempts + 1):
            if attempt == 1:
                response_payload = await generate_scene_json(
                    prompt=tool_prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                    plan=scene_plan,
                    frame_context=frame_context,
                    ai_trace_id=posthog_trace_id,
                    ai_session_id=posthog_session_id,
                    ai_parent_id=posthog_root_span_id,
                )
            else:
                response_payload = await repair_scene_json(
                    prompt=tool_prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                    payload=response_payload or {},
                    issues=validation_issues + review_issues,
                    plan=scene_plan,
                    frame_context=frame_context,
                    ai_trace_id=posthog_trace_id,
                    ai_session_id=posthog_session_id,
                    ai_parent_id=posthog_root_span_id,
                )
            validation_issues = validate_scene_payload(response_payload or {})
            if validation_issues:
                continue
            review_issues = await review_scene_solution(
                prompt=tool_prompt,
                payload=response_payload or {},
                api_key=api_key,
                model=review_model,
                frame_context=frame_context,
                ai_trace_id=posthog_trace_id,
                ai_session_id=posthog_session_id,
                ai_parent_id=posthog_root_span_id,
            )
            if review_issues:
                continue
            break

        title = response_payload.get("title") if response_payload else "Untitled Scene"
        scenes = response_payload.get("scenes") if response_payload else None
        if not isinstance(scenes, list):
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail="AI response did not include scenes.",
            )
        if response_payload:
            _split_state_nodes_by_app(response_payload)
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            settings_payload: dict[str, Any] | None = scene.get("settings") or {}
            if not isinstance(settings_payload, dict):
                settings_payload = {}
                scene["settings"] = settings_payload
            settings_payload["prompt"] = tool_prompt

        reply = f"Generated a new scene: {title}."
        return AiSceneChatResponse(reply=reply, tool=tool, title=title, scenes=scenes)

    if tool == "modify_scene":
        scene_model = openai_settings.get("sceneModel") or SCENE_MODEL
        response_payload: dict[str, Any] | None = None
        validation_issues: list[str] = []
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            response_payload = await modify_scene_json(
                prompt=tool_prompt,
                scene=scene_payload or {},
                context_items=context_items,
                api_key=api_key,
                model=scene_model,
                issues=validation_issues or None,
                frame_context=frame_context,
                selected_nodes=selected_nodes,
                selected_edges=selected_edges,
                ai_trace_id=posthog_trace_id,
                ai_session_id=posthog_session_id,
                ai_parent_id=posthog_root_span_id,
            )
            validation_issues = validate_scene_payload(response_payload or {})
            if not validation_issues:
                break

        scenes = response_payload.get("scenes") if response_payload else None
        if not isinstance(scenes, list) or not scenes:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail="AI response did not include scenes.",
            )
        if data.scene_id and isinstance(scenes[0], dict):
            scenes[0]["id"] = data.scene_id
            if data.scene and isinstance(data.scene, dict):
                existing_name = data.scene.get("name")
                if existing_name and not scenes[0].get("name"):
                    scenes[0]["name"] = existing_name
        if response_payload:
            _split_state_nodes_by_app(response_payload)
        for scene in scenes:
            if not isinstance(scene, dict):
                continue
            settings_payload: dict[str, Any] | None = scene.get("settings") or {}
            if not isinstance(settings_payload, dict):
                settings_payload = {}
                scene["settings"] = settings_payload
            settings_payload["prompt"] = tool_prompt

        reply = "Updated the current scene."
        if validation_issues:
            reply += " Note: the update may need review for validation issues."
        return AiSceneChatResponse(reply=reply, tool=tool, scenes=scenes)

    answer = await answer_frame_question(
        prompt=tool_prompt,
        api_key=api_key,
        context_items=context_items,
        frame_context=frame_context,
        frame_scene_summary=frame_scene_summary,
        history=history,
        model=openai_settings.get("chatModel") or CHAT_MODEL,
        ai_trace_id=posthog_trace_id,
        ai_session_id=posthog_session_id,
        ai_parent_id=posthog_root_span_id,
    )
    return AiSceneChatResponse(reply=answer, tool="reply")
