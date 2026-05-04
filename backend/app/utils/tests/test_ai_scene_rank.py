import pytest

from app.models.ai_embeddings import AiEmbedding
from app.utils.ai_scene import rank_embeddings


def _embedding(
    name: str,
    embedding: list[float],
    *,
    summary: str = "",
    metadata: dict | None = None,
) -> AiEmbedding:
    return AiEmbedding(
        source_type="app",
        source_path=f"apps/{name}",
        name=name,
        summary=summary or name,
        embedding=embedding,
        metadata_json=metadata or {},
    )


def test_rank_embeddings_combines_cosine_and_keyword_scores():
    semantic_only = _embedding(
        "graph",
        [1.0, 0.0],
        summary="A chart component",
    )
    keyword_match = _embedding(
        "weather",
        [0.8, 0.6],
        summary="Weather forecast display",
    )
    unrelated = _embedding(
        "clock",
        [0.0, 1.0],
        summary="Time display",
    )

    ranked = rank_embeddings(
        [1.0, 0.0],
        [semantic_only, keyword_match, unrelated],
        prompt="weather forecast",
        top_k=2,
        min_score=0.0,
    )

    assert [item.name for item in ranked] == ["weather", "graph"]


def test_rank_embeddings_uses_keywords_for_zero_query_vector():
    ranked = rank_embeddings(
        [0.0, 0.0],
        [
            _embedding("calendar", [1.0, 0.0], summary="Events"),
            _embedding("weather", [0.0, 1.0], summary="Forecast"),
        ],
        prompt="weather forecast",
        top_k=1,
        min_score=0.0,
    )

    assert [item.name for item in ranked] == ["weather"]


def test_rank_embeddings_rejects_mismatched_dimensions():
    with pytest.raises(ValueError, match="Embedding dimension mismatch"):
        rank_embeddings(
            [1.0, 0.0],
            [_embedding("weather", [1.0])],
            prompt="weather",
        )
