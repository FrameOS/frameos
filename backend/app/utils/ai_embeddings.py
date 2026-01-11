import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models.ai_embeddings import AiEmbedding, upsert_ai_embedding
from app.utils.ai_scene import create_embeddings, summarize_text


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _summarize_scene_template(template_path: Path, repo_root: Path) -> tuple[str, dict[str, Any]]:
    template = _load_json(template_path)
    name = template.get("name") or template_path.parent.name
    description = template.get("description") or ""
    scenes_data = template.get("scenes")
    if isinstance(scenes_data, str):
        scenes_path = template_path.parent / scenes_data
        if scenes_path.exists():
            scenes_data = _load_json(scenes_path)
        else:
            scenes_data = []

    scene_count = len(scenes_data) if isinstance(scenes_data, list) else 0
    app_keywords: set[str] = set()
    event_keywords: set[str] = set()
    if isinstance(scenes_data, list):
        for scene in scenes_data:
            for node in scene.get("nodes", []):
                data = node.get("data") or {}
                keyword = data.get("keyword")
                if not keyword:
                    continue
                if node.get("type") == "event":
                    event_keywords.add(keyword)
                else:
                    app_keywords.add(keyword)

    summary_input = "\n".join(
        [
            f"Template name: {name}",
            f"Description: {description}",
            f"Scene count: {scene_count}",
            f"App keywords: {', '.join(sorted(app_keywords))}",
            f"Event keywords: {', '.join(sorted(event_keywords))}",
            f"Template path: {template_path.relative_to(repo_root)}",
        ]
    )
    metadata = {
        "name": name,
        "description": description,
        "sceneCount": scene_count,
        "appKeywords": sorted(app_keywords),
        "eventKeywords": sorted(event_keywords),
        "templatePath": str(template_path.relative_to(repo_root)),
    }
    return summary_input, metadata


def _summarize_app_config(config_path: Path, repo_root: Path) -> tuple[str, dict[str, Any]]:
    config = _load_json(config_path)
    name = config.get("name") or config_path.parent.name
    description = config.get("description") or ""
    category = config.get("category") or ""
    fields = [field.get("name") for field in config.get("fields", []) if field.get("name")]
    outputs = [field.get("name") for field in config.get("output", []) if field.get("name")]

    summary_input = "\n".join(
        [
            f"App keyword: {config_path.parent.parent.name}/{config_path.parent.name}",
            f"Name: {name}",
            f"Description: {description}",
            f"Category: {category}",
            f"Fields: {', '.join(fields)}",
            f"Outputs: {', '.join(outputs)}",
            f"Config path: {config_path.relative_to(repo_root)}",
        ]
    )
    metadata = {
        "name": name,
        "description": description,
        "category": category,
        "fields": fields,
        "outputs": outputs,
        "configPath": str(config_path.relative_to(repo_root)),
        "keyword": f"{config_path.parent.parent.name}/{config_path.parent.name}",
    }
    return summary_input, metadata


def _resolve_repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _collect_ai_embedding_items(repo_root: Path) -> list[tuple[str, str, str | None, str, dict[str, Any]]]:
    scenes_root = repo_root / "repo" / "scenes"
    apps_root = repo_root / "frameos" / "src" / "apps"

    items: list[tuple[str, str, str | None, str, dict[str, Any]]] = []

    for template_path in scenes_root.rglob("template.json"):
        summary_input, metadata = _summarize_scene_template(template_path, repo_root)
        items.append(
            (
                "scene",
                str(template_path.parent.relative_to(repo_root)),
                metadata.get("name"),
                summary_input,
                metadata,
            )
        )

    for config_path in apps_root.rglob("config.json"):
        if config_path.parts[-3] == "legacy" and config_path.parts[-4] == "apps" and config_path.parts[-5] == "src":
            continue
        summary_input, metadata = _summarize_app_config(config_path, repo_root)
        items.append(
            (
                "app",
                str(config_path.parent.relative_to(repo_root)),
                metadata.get("name"),
                summary_input,
                metadata,
            )
        )

    return items


def get_ai_embeddings_total(repo_root: Path | None = None) -> int:
    if repo_root is None:
        repo_root = _resolve_repo_root()
    return len(_collect_ai_embedding_items(repo_root))


async def build_ai_embeddings(
    db: Session,
    api_key: str,
    *,
    clear_existing: bool = False,
    only_missing: bool = False,
    summary_model: str,
    embedding_model: str,
) -> int:
    repo_root = _resolve_repo_root()
    items = _collect_ai_embedding_items(repo_root)

    if clear_existing:
        db.query(AiEmbedding).delete(synchronize_session=False)
        db.commit()

    existing_sources: set[tuple[str, str]] = set()
    if only_missing and not clear_existing:
        existing_sources = {
            (row.source_type, row.source_path) for row in db.query(AiEmbedding.source_type, AiEmbedding.source_path)
        }

    for source_type, source_path, name, summary_input, metadata in items:
        if only_missing and (source_type, source_path) in existing_sources:
            continue
        summary_payload = await summarize_text(summary_input, api_key, model=summary_model)
        summary = summary_payload.get("summary") or ""
        keywords = summary_payload.get("keywords") or []
        embedding_input = "\n".join([summary, f"Keywords: {', '.join(keywords)}", summary_input])
        embedding = (await create_embeddings([embedding_input], api_key, model=embedding_model))[0]
        metadata["keywords"] = keywords
        upsert_ai_embedding(
            db,
            source_type=source_type,
            source_path=source_path,
            name=name,
            summary=summary,
            embedding=embedding,
            metadata=metadata,
        )
        db.commit()

    return len(items)
