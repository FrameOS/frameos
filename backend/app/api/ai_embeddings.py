from http import HTTPStatus

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.ai_embeddings import AiEmbedding
from app.models.settings import get_settings_dict
from app.schemas.ai_embeddings import AiEmbeddingsStatusResponse
from app.utils.ai_embeddings import build_ai_embeddings
from . import api_with_auth


@api_with_auth.get("/ai/embeddings/status", response_model=AiEmbeddingsStatusResponse)
def get_ai_embeddings_status(db: Session = Depends(get_db)):
    count = db.query(AiEmbedding).count()
    return AiEmbeddingsStatusResponse(count=count)


@api_with_auth.post("/ai/embeddings/regenerate", response_model=AiEmbeddingsStatusResponse)
async def regenerate_ai_embeddings(db: Session = Depends(get_db)):
    api_key = get_settings_dict(db).get("openAI", {}).get("apiKey")
    if not api_key:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="OpenAI API key not set")

    count = await build_ai_embeddings(db, api_key, clear_existing=True)
    return AiEmbeddingsStatusResponse(count=count)
