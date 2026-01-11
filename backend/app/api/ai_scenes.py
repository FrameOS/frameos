from http import HTTPStatus
from datetime import datetime
from uuid import uuid4
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

from app.database import get_db
from app.models.ai_embeddings import AiEmbedding
from app.models.settings import get_settings_dict
from app.redis import get_redis
from app.schemas.ai_scenes import AiSceneGenerateRequest, AiSceneGenerateResponse, AiSceneContextItem
from app.utils.ai_scene import (
    EMBEDDING_MODEL,
    SCENE_MODEL,
    SCENE_REVIEW_MODEL,
    DEFAULT_APP_CONTEXT_K,
    DEFAULT_SCENE_CONTEXT_K,
    create_embeddings,
    expand_prompt,
    generate_scene_json,
    repair_scene_json,
    validate_scene_blueprint,
    rank_embeddings,
    review_scene_solution,
    validate_scene_payload,
)
from app.websockets import publish_message
from . import api_with_auth


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

    openai_settings = get_settings_dict(db).get("openAI", {})
    api_key = openai_settings.get("apiKey")
    if not api_key:
        await _publish_ai_scene_log(
            redis,
            "OpenAI API key not set.",
            request_id,
            status="error",
            stage="validate",
        )
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI API key not set")

    try:
        await _publish_ai_scene_log(redis, "Loading embeddings.", request_id, stage="context:load")
        embeddings = db.query(AiEmbedding).all()
        context_items: list[AiEmbedding] = []
        if embeddings:
            await _publish_ai_scene_log(redis, "Expanding prompt for retrieval.", request_id, stage="context:expand")
            expanded_prompt = await expand_prompt(prompt, api_key)
            await _publish_ai_scene_log(redis, "Creating retrieval embedding.", request_id, stage="context:embed")
            query_embedding = (
                await create_embeddings(
                    [expanded_prompt],
                    api_key,
                    model=openai_settings.get("embeddingModel") or EMBEDDING_MODEL,
                )
            )[0]
            app_embeddings = [item for item in embeddings if item.source_type == "app"]
            scene_embeddings = [item for item in embeddings if item.source_type == "scene"]
            await _publish_ai_scene_log(redis, "Ranking relevant context.", request_id, stage="context:rank")
            ranked_items = [
                *rank_embeddings(
                    query_embedding,
                    app_embeddings,
                    prompt=expanded_prompt,
                    top_k=DEFAULT_APP_CONTEXT_K,
                ),
                *rank_embeddings(
                    query_embedding,
                    scene_embeddings,
                    prompt=expanded_prompt,
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
            for item in embeddings:
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
        else:
            await _publish_ai_scene_log(
                redis,
                "No embeddings found; generating without retrieval context.",
                request_id,
                stage="context:skip",
            )

        response_payload = None
        blueprint_payload = None
        blueprint_issues: list[str] = []
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
                response_payload, blueprint_payload = await generate_scene_json(
                    prompt=prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                )
            else:
                await _publish_ai_scene_log(
                    redis,
                    "Fixing scene JSON.",
                    request_id,
                    stage="generate",
                )
                response_payload, blueprint_payload = await repair_scene_json(
                    prompt=prompt,
                    context_items=context_items,
                    api_key=api_key,
                    model=scene_model,
                    payload=response_payload or {},
                    issues=validation_issues + review_issues + blueprint_issues,
                )

            blueprint_issues = validate_scene_blueprint(blueprint_payload or {})
            if blueprint_issues:
                await _publish_ai_scene_log(
                    redis,
                    f"Scene blueprint issues: {blueprint_issues}",
                    request_id,
                    status="warning",
                    stage="validate",
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
            if blueprint_issues or validation_issues:
                continue

            review_issues = await review_scene_solution(
                prompt=prompt,
                payload=response_payload or {},
                api_key=api_key,
                model=review_model,
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

        if blueprint_issues or validation_issues or review_issues:
            issue_summary = {
                "blueprint": blueprint_issues,
                "validation": validation_issues,
                "review": review_issues,
            }
            await _publish_ai_scene_log(
                redis,
                f"AI scene generation did not pass validation after retries. Issues: {issue_summary}",
                request_id,
                status="error",
                stage="validate",
            )
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"AI scene generation did not pass validation: {issue_summary}",
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

    return AiSceneGenerateResponse(title=title, scenes=scenes, context=context_response)
