from __future__ import annotations

import json
import os
import hashlib
import re
from pathlib import Path
from app.utils.js_apps import find_js_app_source_filename, find_js_app_source_key

repo_root = Path(__file__).resolve().parents[3]
local_apps_path = str(repo_root / "frameos" / "src" / "apps")
repo_apps_path = str(repo_root / "repo" / "apps")


def _iter_local_app_dirs(include_repo_apps: bool = True):
    seen: set[str] = set()
    frame_apps_root = Path(local_apps_path)
    if frame_apps_root.exists():
        for category_dir in sorted(frame_apps_root.iterdir()):
            if not category_dir.is_dir():
                continue
            for app_dir in sorted(category_dir.iterdir()):
                if not app_dir.is_dir():
                    continue
                keyword = f"{category_dir.name}/{app_dir.name}"
                if keyword in seen:
                    continue
                seen.add(keyword)
                yield keyword, app_dir, {}

    if not include_repo_apps:
        return

    repo_apps_root = Path(repo_apps_path)
    if repo_apps_root.exists():
        for folder_dir in sorted(repo_apps_root.iterdir()):
            if not folder_dir.is_dir():
                continue
            for app_dir in sorted(folder_dir.iterdir()):
                if not app_dir.is_dir():
                    continue
                keyword = f"repo/{folder_dir.name}/{app_dir.name}"
                if keyword in seen:
                    continue
                seen.add(keyword)
                yield keyword, app_dir, {
                    "source": keyword,
                }


def get_local_app_path(keyword: str | None) -> str | None:
    if not keyword:
        return None
    if keyword.startswith("repo/"):
        parts = keyword.split("/")
        if len(parts) == 3:
            app_path = Path(repo_apps_path) / parts[1] / parts[2]
            if app_path.is_dir():
                return str(app_path)
        return None

    app_path = Path(local_apps_path) / keyword
    if app_path.is_dir():
        return str(app_path)
    return None


def is_repo_app(keyword: str | None) -> bool:
    return bool(keyword and keyword.startswith("repo/"))


def get_scene_app_id(keyword: str, sources: dict | None = None) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_]+", "_", keyword).strip("_") or "app"
    digest_input = keyword
    if sources is not None:
        digest_input += "\0" + json.dumps(sources, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha1(digest_input.encode("utf-8")).hexdigest()[:8]
    return f"sceneapp_{slug}_{digest}"


def get_app_configs() -> dict[str, dict]:
    configs = {}
    for keyword, app_dir, metadata in _iter_local_app_dirs():
        config_path = app_dir / "config.json"
        if config_path.exists():
            try:
                with config_path.open('r') as f:
                    config = json.load(f)
                    if 'name' in config:
                        configs[keyword] = {**config, **metadata}
            except Exception as e:
                print(f"Error loading config for {keyword}: {e}")
    return configs


def get_local_frame_apps() -> list[str]:
    clean_apps: list[str] = []
    for keyword, app_dir, _metadata in _iter_local_app_dirs():
        config_path = app_dir / "config.json"
        has_source = (app_dir / "app.nim").exists() or find_js_app_source_filename(str(app_dir))
        if has_source and config_path.exists():
            clean_apps.append(keyword)
    return clean_apps


def get_one_app_sources(keyword: str | None) -> dict[str, str]:
    sources: dict[str, str] = {}
    apps = get_local_frame_apps()
    if keyword in apps:
        local_app_path = get_local_app_path(keyword)
        if not local_app_path:
            return sources
        has_js_source = find_js_app_source_filename(local_app_path) is not None
        files = os.listdir(local_app_path)
        for file in files:
            if file == "app_loader.nim":
                continue
            if has_js_source and file == "app.nim":
                continue
            full_path = os.path.join(local_app_path, file)
            if os.path.isfile(full_path):
                # TODO: also support folders and binary files
                with open(full_path, 'r') as f:
                    sources[file] = f.read()
    return sources


def get_apps_from_scenes(scenes: list[dict]) -> dict[str, dict]:
    apps = {}
    for scene in scenes:
        for node in scene.get('nodes', []):
            sources = node.get('data', {}).get('sources', None)
            if (
                node.get('type') == 'app'
                and isinstance(sources, dict)
                and "app.nim" in sources
                and find_js_app_source_key(sources) is None
            ):
                apps[node['id']] = sources
    return apps


def get_scene_apps_from_scenes(scenes: list[dict]) -> dict[str, dict]:
    apps = {}
    for scene in scenes:
        scene_apps = scene.get("apps", {}) or {}
        if isinstance(scene_apps, dict):
            for keyword, app in scene_apps.items():
                sources = app.get("sources", {}) if isinstance(app, dict) else {}
                if (
                    isinstance(sources, dict)
                    and "app.nim" in sources
                    and find_js_app_source_key(sources) is None
                ):
                    apps[get_scene_app_id(keyword, sources)] = sources

        for node in scene.get("nodes", []):
            if node.get("type") != "app":
                continue
            keyword = node.get("data", {}).get("keyword")
            if not is_repo_app(keyword) or keyword in scene_apps:
                continue
            sources = get_one_app_sources(keyword)
            if "app.nim" in sources and find_js_app_source_key(sources) is None:
                apps[get_scene_app_id(keyword, sources)] = sources
    return apps
