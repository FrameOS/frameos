from http import HTTPStatus

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.ai_embeddings import AiEmbedding
from app.models.settings import get_settings_dict
from app.schemas.ai_embeddings import AiEmbeddingsStatusResponse
from app.utils.ai_embeddings import build_ai_embeddings, get_ai_embeddings_total
from . import api_with_auth


@api_with_auth.get("/ai/embeddings/status", response_model=AiEmbeddingsStatusResponse)
def get_ai_embeddings_status(db: Session = Depends(get_db)):
    count = db.query(AiEmbedding).count()
    total = get_ai_embeddings_total()
    return AiEmbeddingsStatusResponse(count=count, total=total)


@api_with_auth.post("/ai/embeddings/regenerate", response_model=AiEmbeddingsStatusResponse)
async def regenerate_ai_embeddings(db: Session = Depends(get_db)):
    api_key = get_settings_dict(db).get("openAI", {}).get("apiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI API key not set")

    await build_ai_embeddings(db, api_key, clear_existing=True)
    total = get_ai_embeddings_total()
    count = db.query(AiEmbedding).count()
    return AiEmbeddingsStatusResponse(count=count, total=total)


@api_with_auth.post("/ai/embeddings/generate-missing", response_model=AiEmbeddingsStatusResponse)
async def generate_missing_ai_embeddings(db: Session = Depends(get_db)):
    api_key = get_settings_dict(db).get("openAI", {}).get("apiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI API key not set")

    await build_ai_embeddings(db, api_key, only_missing=True)
    total = get_ai_embeddings_total()
    count = db.query(AiEmbedding).count()
    return AiEmbeddingsStatusResponse(count=count, total=total)


@api_with_auth.delete("/ai/embeddings", response_model=AiEmbeddingsStatusResponse)
def delete_ai_embeddings(db: Session = Depends(get_db)):
    db.query(AiEmbedding).delete(synchronize_session=False)
    db.commit()
    total = get_ai_embeddings_total()
    return AiEmbeddingsStatusResponse(count=0, total=total)
