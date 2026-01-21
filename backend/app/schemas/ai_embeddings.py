from pydantic import BaseModel


class AiEmbeddingsStatusResponse(BaseModel):
    count: int
    total: int
