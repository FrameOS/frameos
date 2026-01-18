import json
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models.ai_embeddings import AiEmbedding, upsert_ai_embedding
from app.utils.ai_scene import create_embeddings, summarize_text

MAX_SNIPPET_LENGTH = 1200


def _truncate_text(value: str, max_length: int = MAX_SNIPPET_LENGTH) -> str:
    if len(value) <= max_length:
        return value
    return f"{value[:max_length]}…"


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
    node_types: set[str] = set()
    preview_nodes: list[dict[str, Any]] = []
    if isinstance(scenes_data, list):
        for scene in scenes_data:
            for node in scene.get("nodes", []):
                if node.get("type"):
                    node_types.add(node.get("type"))
                data = node.get("data") or {}
                keyword = data.get("keyword")
                if not keyword:
                    continue
                if node.get("type") == "event":
                    event_keywords.add(keyword)
                else:
                    app_keywords.add(keyword)
            if not preview_nodes and scene.get("nodes"):
                preview_nodes = [
                    {
                        "id": node.get("id"),
                        "type": node.get("type"),
                        "keyword": (node.get("data") or {}).get("keyword"),
                    }
                    for node in scene.get("nodes", [])[:8]
                ]

    summary_input = "\n".join(
        [
            f"Template name: {name}",
            f"Description: {description}",
            f"Scene count: {scene_count}",
            f"App keywords: {', '.join(sorted(app_keywords))}",
            f"Event keywords: {', '.join(sorted(event_keywords))}",
            f"Node types: {', '.join(sorted(node_types))}",
            f"Template path: {template_path.relative_to(repo_root)}",
        ]
    )
    metadata = {
        "name": name,
        "description": description,
        "sceneCount": scene_count,
        "appKeywords": sorted(app_keywords),
        "eventKeywords": sorted(event_keywords),
        "nodeTypes": sorted(node_types),
        "previewNodes": preview_nodes,
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
    settings = config.get("settings") or []
    field_details = [
        {
            "name": field.get("name"),
            "type": field.get("type"),
            "label": field.get("label"),
            "required": field.get("required"),
            "options": field.get("options"),
        }
        for field in config.get("fields", [])
        if field.get("name")
    ]
    field_options = [
        f"{field['name']}: {', '.join(field.get('options') or [])}"
        for field in config.get("fields", [])
        if field.get("name") and field.get("options")
    ]
    output_details = [
        {
            "name": field.get("name"),
            "type": field.get("type"),
            "label": field.get("label"),
        }
        for field in config.get("output", [])
        if field.get("name")
    ]
    config_snippet = _truncate_text(json.dumps(config, ensure_ascii=False))

    summary_input = "\n".join(
        [
            f"App keyword: {config_path.parent.parent.name}/{config_path.parent.name}",
            f"Name: {name}",
            f"Description: {description}",
            f"Category: {category}",
            f"Fields: {', '.join(fields)}",
            f"Field options: {', '.join(field_options)}",
            f"Outputs: {', '.join(outputs)}",
            f"Settings: {', '.join(settings)}",
            f"Config path: {config_path.relative_to(repo_root)}",
        ]
    )
    metadata = {
        "name": name,
        "description": description,
        "category": category,
        "fields": fields,
        "fieldDetails": field_details,
        "outputs": outputs,
        "outputDetails": output_details,
        "settings": settings,
        "configPath": str(config_path.relative_to(repo_root)),
        "keyword": f"{config_path.parent.parent.name}/{config_path.parent.name}",
        "configSnippet": config_snippet,
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
        metadata_block = "\n".join(
            [
                f"Metadata fields: {json.dumps(metadata.get('fieldDetails') or metadata.get('fields') or [], ensure_ascii=False)}",
                f"Metadata outputs: {json.dumps(metadata.get('outputDetails') or metadata.get('outputs') or [], ensure_ascii=False)}",
                f"Metadata app keywords: {', '.join(metadata.get('appKeywords') or [])}",
                f"Metadata event keywords: {', '.join(metadata.get('eventKeywords') or [])}",
                f"Metadata node types: {', '.join(metadata.get('nodeTypes') or [])}",
                f"Metadata preview nodes: {json.dumps(metadata.get('previewNodes') or [], ensure_ascii=False)}",
            ]
        )
        embedding_input = "\n".join([summary, f"Keywords: {', '.join(keywords)}", summary_input, metadata_block])
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
