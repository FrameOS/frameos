"""The repo's JavaScript app templates, `repo/apps/<folder>/<name>`.

The folder says what the app returns (image, text, json, logic). A template is
not a keyword a frame knows: a scene carries its own copy in the scene's
`apps` map under `<name>`, with `origin` naming the template, and its nodes use
`keyword: "<name>"` (docs/scene-guide.md, "Apps"). The editor makes that copy
when someone adds the app; the scene AI's output goes through
bundle_repo_apps, the same rule as the cloud's bundleRepoApps.

Until 2026.10.13 every template sat under repo/apps/code, so an old keyword
finds its app by the name.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_APPS_ROOT = Path(__file__).resolve().parents[3] / "repo" / "apps"
REPO_APP_PREFIX = "repo/apps/"


def _templates() -> dict[str, Path]:
    """Every template folder with a config.json, by app name."""
    found: dict[str, Path] = {}
    if not REPO_APPS_ROOT.is_dir():
        return found
    for folder in sorted(REPO_APPS_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if (path / "config.json").is_file():
                found.setdefault(path.name, path)
    return found


def _template_dir(keyword: str) -> Path | None:
    parts = keyword.split("/")
    if len(parts) != 4 or parts[:2] != ["repo", "apps"] or not parts[3] or parts[3].startswith("."):
        return None
    return _templates().get(parts[3])


def _keyword(path: Path) -> str:
    return f"{REPO_APP_PREFIX}{path.parent.name}/{path.name}"


def repo_app_configs() -> dict[str, dict[str, Any]]:
    """Every template's config.json, by its `repo/apps/<folder>/<name>` keyword."""
    configs: dict[str, dict[str, Any]] = {}
    for path in _templates().values():
        try:
            config = json.loads((path / "config.json").read_text())
        except (OSError, ValueError):
            continue
        if isinstance(config, dict):
            configs[_keyword(path)] = config
    return configs


def repo_app_sources(keyword: str) -> dict[str, str]:
    """A template's files by name, helper folders included; {} when there is none."""
    root = _template_dir(keyword)
    if root is None:
        return {}
    sources: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(root).parts):
            try:
                sources[path.relative_to(root).as_posix()] = path.read_text()
            except (OSError, UnicodeDecodeError):
                continue
    return sources


def bundle_repo_apps(payload: dict[str, Any]) -> list[str]:
    """Copy every template a scene's nodes name by `repo/apps/<folder>/<name>`
    into that scene's `apps` map and point the nodes at `<name>`. Mutates the
    payload (`{"scenes": [...]}`) in place and says what it did."""
    bundled: list[str] = []
    scenes = payload.get("scenes")
    for scene in scenes if isinstance(scenes, list) else []:
        if not isinstance(scene, dict):
            continue
        for node in scene.get("nodes") or []:
            if not isinstance(node, dict) or node.get("type") != "app":
                continue
            data = node.get("data")
            if not isinstance(data, dict):
                continue
            keyword = data.get("keyword")
            root = _template_dir(keyword) if isinstance(keyword, str) else None
            if root is None:
                continue
            apps = scene.get("apps")
            if not isinstance(apps, dict):
                apps = scene["apps"] = {}
            if root.name not in apps:
                current = _keyword(root)
                config = repo_app_configs().get(current, {})
                apps[root.name] = {**config, "origin": current, "sources": repo_app_sources(current)}
            data["keyword"] = root.name
            bundled.append(f"{keyword} -> apps.{root.name}")
    return bundled
