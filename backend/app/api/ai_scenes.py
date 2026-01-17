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
from app.schemas.ai_scenes import AiSceneGenerateRequest, AiSceneGenerateResponse, AiSceneContextItem
from app.config import config
from app.utils.ai_scene import (
    EMBEDDING_MODEL,
    SCENE_MODEL,
    SCENE_REVIEW_MODEL,
    DEFAULT_APP_CONTEXT_K,
    DEFAULT_SCENE_CONTEXT_K,
    create_embeddings,
    generate_scene_json,
    repair_scene_json,
    rank_embeddings,
    review_scene_solution,
    validate_scene_payload,
)
from app.utils.posthog import get_posthog_client, llm_analytics_enabled
from app.websockets import publish_message
from . import api_with_auth

AI_ID_PATTERN = re.compile(r"[^A-Za-z0-9\\-_.@()!'~:|]")

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
        await _publish_ai_scene_log(redis, "Loading embeddings.", request_id, stage="context:load")
        embeddings = db.query(AiEmbedding).all()
        missing_service_keys = _get_missing_service_keys(settings)
        available_embeddings = _filter_embeddings_for_services(embeddings, missing_service_keys)
        context_items: list[AiEmbedding] = []
        if available_embeddings:
            await _publish_ai_scene_log(redis, "Creating retrieval embedding.", request_id, stage="context:embed")
            query_embedding = (
                await create_embeddings(
                    [prompt],
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
            seen: set[tuple[str, str]] = set()
            context_items = []
            for item in ranked_items:
                key = (item.source_type, item.source_path)
                if key in seen:
                    continue
                seen.add(key)
                context_items.append(item)
            for item in available_embeddings:
                key = (item.source_type, item.source_path)
                if key in seen:
                    continue
                seen.add(key)
                context_items.append(item)
            await _publish_ai_scene_log(
                redis,
                f"Selected {len(context_items)} context items.",
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

        response_payload = None
        validation_issues: list[str] = []
        review_issues: list[str] = []
        max_attempts = 3
        scene_model = openai_settings.get("sceneModel") or SCENE_MODEL
        review_model = openai_settings.get("reviewModel") or SCENE_REVIEW_MODEL
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

    title = response_payload.get("title")
    scenes = response_payload.get("scenes")
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
