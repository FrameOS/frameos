from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal

from app.models.apps import get_app_configs

MAX_DESCRIPTION_LENGTH = 220
MAX_COMPACT_ITEMS_PER_SECTION = 120

CORE_CONTEXT_PATHS = {
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


@dataclass(frozen=True)
class AiCatalogItem:
    source_type: Literal["app", "scene"]
    source_path: str
    name: str | None
    summary: str
    metadata_json: dict[str, Any]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _truncate(value: str, max_length: int = MAX_DESCRIPTION_LENGTH) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= max_length:
        return normalized
    return normalized[: max_length - 1].rstrip() + "…"


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def missing_service_keys(settings: dict[str, Any]) -> set[str]:
    missing: set[str] = set()
    for service_key, details in SERVICE_SECRET_FIELDS.items():
        fields = details.get("fields", ())
        service_settings = settings.get(service_key) or {}
        if any(not _has_value(service_settings.get(field)) for field in fields):
            missing.add(service_key)
    return missing


def _settings_available(required_settings: list[str], missing_keys: set[str]) -> bool:
    return not any(
        setting in missing_keys and not SERVICE_SECRET_FIELDS.get(setting, {}).get("free_limited_usage")
        for setting in required_settings
    )


def _field_details(fields: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    for field in fields:
        if not isinstance(field, dict) or not field.get("name"):
            continue
        detail = {
            key: field.get(key)
            for key in (
                "name",
                "type",
                "label",
                "description",
                "required",
                "value",
                "options",
                "example",
            )
            if field.get(key) is not None
        }
        details.append(detail)
    return details


def _app_item(keyword: str, config: dict[str, Any]) -> AiCatalogItem:
    source_path = f"frameos/src/apps/{keyword}"
    name = config.get("name") or keyword
    description = config.get("description") or ""
    category = config.get("category") or ""
    field_details = _field_details(config.get("fields") or [])
    output_details = _field_details(config.get("output") or [])
    settings = [str(setting) for setting in (config.get("settings") or [])]
    fields = [str(field["name"]) for field in field_details if field.get("name")]
    outputs = [str(field["name"]) for field in output_details if field.get("name")]
    summary_parts = [
        description,
        f"Category: {category}." if category else "",
        f"Inputs: {', '.join(fields)}." if fields else "",
        f"Outputs: {', '.join(outputs)}." if outputs else "",
        f"Requires settings: {', '.join(settings)}." if settings else "",
    ]
    summary = _truncate(" ".join(part for part in summary_parts if part), 420)
    return AiCatalogItem(
        source_type="app",
        source_path=source_path,
        name=name,
        summary=summary,
        metadata_json={
            "keyword": keyword,
            "category": category,
            "description": description,
            "fields": fields,
            "fieldDetails": field_details,
            "outputs": outputs,
            "outputDetails": output_details,
            "settings": settings,
            "config": {
                key: value
                for key, value in config.items()
                if key
                in {
                    "name",
                    "category",
                    "description",
                    "version",
                    "fields",
                    "output",
                    "settings",
                    "cache",
                }
            },
        },
    )


def _condense_scene(scene: dict[str, Any]) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[str] = []
    for node in scene.get("nodes", []):
        if not isinstance(node, dict):
            continue
        data = node.get("data") or {}
        condensed: dict[str, Any] = {"id": node.get("id"), "type": node.get("type")}
        keyword = data.get("keyword")
        if keyword:
            condensed["keyword"] = keyword
        nodes.append(condensed)

    for edge in scene.get("edges", []):
        if not isinstance(edge, dict):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if not source or not target:
            continue
        source_handle = edge.get("sourceHandle")
        target_handle = edge.get("targetHandle")
        if source_handle or target_handle:
            source_part = f"{source}:{source_handle}" if source_handle else str(source)
            target_part = f"{target}:{target_handle}" if target_handle else str(target)
            edges.append(f"{source_part}->{target_part}")
        else:
            edges.append(f"{source}->{target}")
    return {"nodes": nodes, "edges": edges}


def _scene_item(template_path: Path, repo_root: Path) -> AiCatalogItem:
    template = _load_json(template_path)
    name = template.get("name") or template_path.parent.name
    description = template.get("description") or ""
    scenes_data = template.get("scenes")
    if isinstance(scenes_data, str):
        scenes_path = template_path.parent / scenes_data
        scenes_data = _load_json(scenes_path) if scenes_path.exists() else []

    app_keywords: set[str] = set()
    event_keywords: set[str] = set()
    node_types: set[str] = set()
    example_scene: dict[str, Any] | None = None
    if isinstance(scenes_data, list):
        for scene in scenes_data:
            if not isinstance(scene, dict):
                continue
            if example_scene is None:
                example_scene = _condense_scene(scene)
            for node in scene.get("nodes", []):
                if not isinstance(node, dict):
                    continue
                node_type = node.get("type")
                if node_type:
                    node_types.add(str(node_type))
                keyword = (node.get("data") or {}).get("keyword")
                if not keyword:
                    continue
                if node_type == "event":
                    event_keywords.add(str(keyword))
                else:
                    app_keywords.add(str(keyword))

    summary_parts = [
        description,
        f"Apps used: {', '.join(sorted(app_keywords))}." if app_keywords else "",
        f"Events: {', '.join(sorted(event_keywords))}." if event_keywords else "",
    ]
    return AiCatalogItem(
        source_type="scene",
        source_path=str(template_path.parent.relative_to(repo_root)),
        name=name,
        summary=_truncate(" ".join(part for part in summary_parts if part), 420),
        metadata_json={
            "description": description,
            "appKeywords": sorted(app_keywords),
            "eventKeywords": sorted(event_keywords),
            "nodeTypes": sorted(node_types),
            "scene": example_scene or {},
            "template": {
                key: value
                for key, value in template.items()
                if key in {"name", "description", "fields", "settings"}
            },
        },
    )


def collect_catalog_items(settings: dict[str, Any] | None = None) -> list[AiCatalogItem]:
    repo_root = _repo_root()
    missing_keys = missing_service_keys(settings or {})
    items: list[AiCatalogItem] = []
    for keyword, config in sorted(get_app_configs().items()):
        item = _app_item(keyword, config)
        required_settings = item.metadata_json.get("settings") or []
        if _settings_available(required_settings, missing_keys):
            items.append(item)

    scenes_root = repo_root / "repo" / "scenes"
    if scenes_root.exists():
        for template_path in sorted(scenes_root.rglob("template.json")):
            items.append(_scene_item(template_path, repo_root))

    return items


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_/.-]+", value.lower()))


def _item_haystack(item: AiCatalogItem) -> str:
    metadata = item.metadata_json or {}
    parts = [
        item.name or "",
        item.source_path,
        item.summary,
        metadata.get("keyword") or "",
        metadata.get("category") or "",
        metadata.get("description") or "",
        " ".join(metadata.get("fields") or []),
        " ".join(metadata.get("outputs") or []),
        " ".join(metadata.get("settings") or []),
        " ".join(metadata.get("appKeywords") or []),
        " ".join(metadata.get("eventKeywords") or []),
        " ".join(metadata.get("nodeTypes") or []),
    ]
    return " ".join(str(part) for part in parts if part)


def search_catalog_items(
    items: list[AiCatalogItem],
    query: str,
    *,
    source_type: str | None = None,
    limit: int = 12,
) -> list[AiCatalogItem]:
    query_tokens = _tokens(query)
    candidates = [item for item in items if source_type is None or item.source_type == source_type]
    if not query_tokens:
        return candidates[:limit]

    scored: list[tuple[float, AiCatalogItem]] = []
    for item in candidates:
        haystack = _item_haystack(item).lower()
        haystack_tokens = _tokens(haystack)
        token_hits = sum(1 for token in query_tokens if token in haystack)
        exact_hits = len(query_tokens & haystack_tokens)
        score = token_hits + (2 * exact_hits)
        if score > 0:
            scored.append((score, item))
    scored.sort(key=lambda pair: (-pair[0], pair[1].source_type, pair[1].source_path))
    return [item for _, item in scored[:limit]]


def ensure_catalog_details(
    items: list[AiCatalogItem],
    selected: Iterable[AiCatalogItem],
) -> list[AiCatalogItem]:
    selected_keys = {(item.source_type, item.source_path) for item in selected}
    details: list[AiCatalogItem] = [
        item
        for item in items
        if item.source_path in CORE_CONTEXT_PATHS and (item.source_type, item.source_path) not in selected_keys
    ]
    return [*details, *selected]


def build_catalog_context(
    items: list[AiCatalogItem],
    *,
    query: str,
    include_details: bool = True,
) -> tuple[str, list[AiCatalogItem]]:
    app_items = [item for item in items if item.source_type == "app"]
    scene_items = [item for item in items if item.source_type == "scene"]
    selected = ensure_catalog_details(
        items,
        [
            *search_catalog_items(app_items, query, limit=10),
            *search_catalog_items(scene_items, query, limit=6),
        ],
    )
    seen: set[tuple[str, str]] = set()
    detail_items: list[AiCatalogItem] = []
    for item in selected:
        key = (item.source_type, item.source_path)
        if key in seen:
            continue
        seen.add(key)
        detail_items.append(item)

    compact_apps = "\n".join(_compact_line(item) for item in app_items[:MAX_COMPACT_ITEMS_PER_SECTION])
    compact_scenes = "\n".join(_compact_line(item) for item in scene_items[:MAX_COMPACT_ITEMS_PER_SECTION])
    sections = [
        "FrameOS catalog lookup tool (authoritative). Use this direct app/scene catalog before selecting tools.",
        "Tool shape: list_frameos_catalog(query?: string, source_type?: 'app'|'scene', detail_paths?: string[], detail_level?: 'summary'|'full').",
        "Before choosing apps or examples, consult the compact list below. If a listed tool/example looks relevant, use the detailed entries in this context; if the user asks a broad question, explain that more listed entries can be inspected by keyword/source path.",
        "Compact app list (keyword/source path - name - category - default summary):",
        compact_apps or "(no apps available)",
        "Compact scene example list (source path - name - default summary):",
        compact_scenes or "(no scene examples available)",
    ]
    if include_details:
        sections.extend(
            [
                "Default detailed catalog entries for this request and core tools:",
                "\n\n".join(_detail_block(item) for item in detail_items) or "(no detailed entries selected)",
            ]
        )
    return "\n\n".join(sections), detail_items


def _compact_line(item: AiCatalogItem) -> str:
    metadata = item.metadata_json or {}
    if item.source_type == "app":
        keyword = metadata.get("keyword") or item.source_path.replace("frameos/src/apps/", "")
        category = metadata.get("category") or "unknown"
        return f"- {keyword} ({item.source_path}) - {item.name or keyword} - {category} - {_truncate(item.summary)}"
    return f"- {item.source_path} - {item.name or item.source_path} - {_truncate(item.summary)}"


def _detail_block(item: AiCatalogItem) -> str:
    metadata = item.metadata_json or {}
    lines = [
        f"[{item.source_type}] {item.name or item.source_path}",
        f"Source path: {item.source_path}",
        f"Summary: {item.summary}",
    ]
    if item.source_type == "app":
        lines.extend(
            [
                f"Keyword: {metadata.get('keyword')}",
                f"Category: {metadata.get('category')}",
                f"Required settings: {', '.join(metadata.get('settings') or []) or 'none'}",
                f"Fields: {json.dumps(metadata.get('fieldDetails') or [], ensure_ascii=False)}",
                f"Outputs: {json.dumps(metadata.get('outputDetails') or [], ensure_ascii=False)}",
                f"Config JSON (selected keys): {json.dumps(metadata.get('config') or {}, ensure_ascii=False)}",
            ]
        )
    else:
        lines.extend(
            [
                f"App keywords used: {', '.join(metadata.get('appKeywords') or []) or 'none'}",
                f"Event keywords used: {', '.join(metadata.get('eventKeywords') or []) or 'none'}",
                f"Node types: {', '.join(metadata.get('nodeTypes') or []) or 'none'}",
                f"Scene JSON (condensed): {json.dumps(metadata.get('scene') or {}, ensure_ascii=False)}",
                f"Template JSON (selected keys): {json.dumps(metadata.get('template') or {}, ensure_ascii=False)}",
            ]
        )
    return "\n".join(line for line in lines if line)
