from http import HTTPStatus
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.ai_embeddings import AiEmbedding
from app.models.settings import get_settings_dict
from app.schemas.ai_scenes import AiSceneGenerateRequest, AiSceneGenerateResponse, AiSceneContextItem
from app.utils.ai_scene import (
    EMBEDDING_MODEL,
    SCENE_MODEL,
    create_embeddings,
    generate_scene_json,
    rank_embeddings,
)
from . import api_with_auth


@api_with_auth.post("/ai/scenes/generate", response_model=AiSceneGenerateResponse)
async def generate_scene(data: AiSceneGenerateRequest, db: Session = Depends(get_db)):
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Prompt is required")

    openai_settings = get_settings_dict(db).get("openAI", {})
    api_key = openai_settings.get("apiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI API key not set")

    embeddings = db.query(AiEmbedding).all()
    context_items: list[AiEmbedding] = []
    if embeddings:
        query_embedding = (
            await create_embeddings(
                [prompt],
                api_key,
                model=openai_settings.get("embeddingModel") or EMBEDDING_MODEL,
            )
        )[0]
        context_items = rank_embeddings(query_embedding, embeddings, top_k=8)

    response_payload = await generate_scene_json(
        prompt=prompt,
        context_items=context_items,
        api_key=api_key,
        model=openai_settings.get("sceneModel") or SCENE_MODEL,
    )

    title = response_payload.get("title")
    scenes = response_payload.get("scenes")
    if not isinstance(scenes, list):
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail="AI response did not include scenes",
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

    return AiSceneGenerateResponse(title=title, scenes=scenes, context=context_response)
