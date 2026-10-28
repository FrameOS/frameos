"""The scene half of the AI chat's tools (docs/ai-chat.md): getting a scene the
model wrote, whole or as a patch, into the user's editor.

A port of the cloud's delivery tools (cloud/apps/auth-web/src/lib/ai/tools.ts:
deliverScenes, applyScenePatch, applySourceEdits). The two must merge a patch
the same way, so both replay docs/ai-scene-patch-fixtures.json in their tests:
change one, change the other and the fixtures.

Nothing here writes anywhere. A delivered scene goes to the browser as a
`scenes` event; the user's Save (or the model's own frame_scene_update, which
takes confirm) is what changes a frame."""
from __future__ import annotations

import copy
import json
from typing import Any, Callable

from app.utils.ai_scene import validate_scene_payload
from app.utils.repo_apps import bundle_repo_apps
from app.utils.retired_apps import retire_apps_in_scenes

JsonObject = dict[str, Any]


def coerce_delivered_scenes(raw: Any) -> list[Any]:
    """`scenes` is documented as an array of scene objects, but models also send
    a lone scene, the array re-encoded as a JSON string, or the array wrapped
    in another `{scenes}`. Accept those rather than report a scene without
    nodes."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            return coerce_delivered_scenes(json.loads(text))
        except ValueError:
            return []
    if isinstance(raw, dict):
        if isinstance(raw.get("scenes"), list):
            return raw["scenes"]
        if any(key in raw for key in ("nodes", "id", "name")):
            return [raw]
    return []


def partial_scene_issue(current: JsonObject, delivered: JsonObject) -> str | None:
    """update_scene must carry the WHOLE scene. A model under pressure sends
    just the nodes it touched, which the editor would apply as "delete the
    rest": refuse when most of the current node ids vanish."""

    def ids(scene: JsonObject) -> set[str]:
        nodes = _as_list(scene.get("nodes"))
        return {node["id"] for node in nodes if isinstance(node, dict) and isinstance(node.get("id"), str)}

    before = ids(current)
    after = ids(delivered)
    if len(before) < 4:
        return None
    kept = len(before & after)
    if kept / len(before) >= 0.5:
        return None
    return (
        f"This looks like a partial update: the current scene has {len(before)} nodes and only {kept} of their ids are in "
        f"the delivered scene ({len(after)} nodes). update_scene replaces the WHOLE scene. Either call patch_scene / "
        "edit_app_source with just the parts that change (nodes by id, app source files, find/replace edits — cheapest, "
        "preferred), or send the complete scene — every existing node, edge, field and the \"apps\" map — with your "
        "changes applied and the original node ids kept. If the user really asked to replace most of the scene, call "
        "update_scene again with rewrite: true. Do this now, in this turn; do not ask the user whether to retry."
    )


def validate_app_keywords(payload: JsonObject, known_keywords: set[str]) -> list[str]:
    """Every app node names an app the catalog has, or one the scene bundles."""
    issues: list[str] = []
    scenes = _as_list(payload.get("scenes"))
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        scene_apps = set(scene["apps"].keys()) if isinstance(scene.get("apps"), dict) else set()
        for node in scene.get("nodes") or []:
            if not isinstance(node, dict) or node.get("type") != "app":
                continue
            data = _as_dict(node.get("data"))
            keyword = data.get("keyword")
            if not isinstance(keyword, str) or not keyword:
                issues.append(f"Scene {index} has an app node without a keyword.")
                continue
            inline = isinstance(data.get("sources"), dict) and len(data["sources"]) > 0
            if keyword not in known_keywords and keyword not in scene_apps and not inline:
                issues.append(
                    f"Scene {index} uses unknown app keyword '{keyword}'. Use apps_list to find valid keywords."
                )
    return issues


def _as_dict(value: Any) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _object_list(value: Any) -> list[JsonObject]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _edge_matches(edge: JsonObject, matcher: JsonObject) -> bool:
    for key in ("source", "target", "sourceHandle", "targetHandle"):
        if key in matcher and edge.get(key) != matcher[key]:
            return False
    return True


def apply_scene_patch(base: JsonObject, args: JsonObject) -> tuple[JsonObject, list[str], list[str]]:
    """Merge a patch_scene payload onto a scene: (scene, changes, issues). The
    caller refuses the whole patch when there are issues, so a typo never
    half-applies."""
    scene = copy.deepcopy(base)
    changes: list[str] = []
    issues: list[str] = []
    nodes = _object_list(scene.get("nodes"))
    edges = _object_list(scene.get("edges"))

    name = args.get("name")
    if isinstance(name, str) and name.strip():
        scene["name"] = name.strip()
        changes.append(f'renamed scene to "{scene["name"]}"')

    remove_nodes = list(dict.fromkeys(_string_list(args.get("remove_nodes"))))
    for node_id in remove_nodes:
        if not any(node.get("id") == node_id for node in nodes):
            issues.append(f'remove_nodes: no node with id "{node_id}".')
    if remove_nodes and not issues:
        before = len(edges)
        edges = [edge for edge in edges if edge.get("source") not in remove_nodes and edge.get("target") not in remove_nodes]
        changes.append(
            f"removed {len(remove_nodes)} node(s)"
            + (f" and {before - len(edges)} attached edge(s)" if before != len(edges) else "")
        )
    next_nodes = [node for node in nodes if node.get("id") not in remove_nodes]

    added = replaced = 0
    for node in _object_list(args.get("set_nodes")):
        new_id = node.get("id")
        if not isinstance(new_id, str) or not new_id:
            issues.append("set_nodes: every node needs a string id.")
            continue
        if not isinstance(node.get("type"), str) or not node.get("type"):
            issues.append(f'set_nodes: node "{new_id}" needs a type.')
            continue
        index = next((i for i, existing in enumerate(next_nodes) if existing.get("id") == new_id), -1)
        if index == -1:
            next_nodes.append(node)
            added += 1
        else:
            next_nodes[index] = node
            replaced += 1
    if added or replaced:
        changes.append(f"nodes: {replaced} replaced, {added} added")

    removed_edges = 0
    for matcher in _as_list(args.get("remove_edges")):
        before = len(edges)
        if isinstance(matcher, str):
            edges = [edge for edge in edges if edge.get("id") != matcher]
        elif isinstance(matcher, dict):
            edges = [edge for edge in edges if not _edge_matches(edge, matcher)]
        else:
            issues.append("remove_edges: entries must be edge ids or {source,target} matchers.")
            continue
        if len(edges) == before:
            issues.append(f"remove_edges: nothing matched {json.dumps(matcher, separators=(',', ':'))}.")
        removed_edges += before - len(edges)
    if removed_edges:
        changes.append(f"removed {removed_edges} edge(s)")

    edges_added = edges_replaced = 0
    for edge in _object_list(args.get("set_edges")):
        if not isinstance(edge.get("source"), str) or not isinstance(edge.get("target"), str):
            issues.append("set_edges: every edge needs string source and target node ids.")
            continue
        index = (
            next((i for i, existing in enumerate(edges) if existing.get("id") == edge["id"]), -1)
            if isinstance(edge.get("id"), str)
            else -1
        )
        if index == -1:
            edges.append(edge)
            edges_added += 1
        else:
            edges[index] = edge
            edges_replaced += 1
    if edges_added or edges_replaced:
        changes.append(f"edges: {edges_replaced} replaced, {edges_added} added")

    if isinstance(args.get("fields"), list):
        scene["fields"] = args["fields"]
        changes.append(f"fields replaced ({len(args['fields'])})")
    if isinstance(args.get("settings"), dict):
        current = _as_dict(scene.get("settings"))
        scene["settings"] = {**current, **args["settings"]}
        changes.append(f"settings merged ({', '.join(args['settings'].keys())})")

    if isinstance(args.get("apps"), dict):
        apps = dict(_as_dict(scene.get("apps")))
        for keyword, patch in args["apps"].items():
            if patch is None:
                if keyword not in apps:
                    issues.append(f'apps: no app "{keyword}" to remove.')
                    continue
                del apps[keyword]
                changes.append(f"removed app {keyword}")
                continue
            if not isinstance(patch, dict):
                issues.append(f"apps.{keyword}: must be an object or null.")
                continue
            existing = _as_dict(apps.get(keyword))
            rest = {key: value for key, value in patch.items() if key != "sources"}
            merged = {**existing, **rest}
            if "sources" in patch:
                source_patch = patch["sources"]
                if not isinstance(source_patch, dict):
                    issues.append(f"apps.{keyword}.sources: must be a {{ file: content }} object.")
                    continue
                sources = dict(_as_dict(existing.get("sources")))
                touched: list[str] = []
                for file, content in source_patch.items():
                    if content is None:
                        if file not in sources:
                            issues.append(f'apps.{keyword}.sources: no file "{file}" to remove.')
                            continue
                        del sources[file]
                        touched.append(f"-{file}")
                    elif isinstance(content, str):
                        touched.append(file if file in sources else f"+{file}")
                        sources[file] = content
                    else:
                        issues.append(f"apps.{keyword}.sources.{file}: content must be a string (or null to remove).")
                merged["sources"] = sources
                if touched:
                    changes.append(f"app {keyword} sources: {', '.join(touched)}")
            elif rest:
                changes.append(f"app {keyword}: {', '.join(rest.keys())} updated")
            apps[keyword] = merged
        scene["apps"] = apps

    scene["nodes"] = next_nodes
    scene["edges"] = edges
    return scene, changes, issues


def apply_source_edits(base: JsonObject, args: JsonObject) -> tuple[JsonObject, list[str], str]:
    """Exact find/replace inside one source string of a scene: (scene, issues,
    summary). Refuses when a find is ambiguous or missing, so the model gets a
    precise reason instead of a silently unchanged file."""
    scene = copy.deepcopy(base)
    issues: list[str] = []
    edits = _object_list(args.get("edits"))
    app = args.get("app") if isinstance(args.get("app"), str) else None
    node_id = args.get("node_id") if isinstance(args.get("node_id"), str) else None
    file = args.get("file") if isinstance(args.get("file"), str) else None
    if not edits:
        return scene, ["edits: send at least one { find, replace } or { from, to, replace }."], ""
    if not app and not node_id:
        return scene, ["Name the target: `app` (+ `file`) for a bundled app, or `node_id` for a node."], ""

    current: str | None = None
    setter: Callable[[str], None] | None = None
    where = ""
    if app:
        apps = _as_dict(scene.get("apps"))
        entry = apps.get(app)
        if not isinstance(entry, dict):
            issues.append(f'No app "{app}" in this scene\'s apps map (have: {", ".join(apps.keys()) or "none"}).')
        else:
            sources = _as_dict(entry.get("sources"))
            target = file or (next(iter(sources)) if len(sources) == 1 else None)
            if not target:
                issues.append(f'Which file? App "{app}" has: {", ".join(sources.keys()) or "no sources"}.')
            elif not isinstance(sources.get(target), str):
                issues.append(f'App "{app}" has no file "{target}" (have: {", ".join(sources.keys()) or "none"}).')
            else:
                current = sources[target]

                def set_app_source(value: str, sources=sources, target=target, entry=entry) -> None:
                    sources[target] = value
                    entry["sources"] = sources

                setter = set_app_source
                where = f"{app}/{target}"
    elif node_id:
        node = next((candidate for candidate in _object_list(scene.get("nodes")) if candidate.get("id") == node_id), None)
        if node is None:
            issues.append(f'No node with id "{node_id}".')
        else:
            data = _as_dict(node.get("data"))
            node["data"] = data
            raw_sources = data.get("sources")
            node_sources = raw_sources if isinstance(raw_sources, dict) else None
            if file and node_sources is not None and isinstance(node_sources.get(file), str):
                current = node_sources[file]
                setter = lambda value, node_sources=node_sources, file=file: node_sources.__setitem__(file, value)  # noqa: E731
                where = f"node {node_id}/{file}"
            elif not file and node.get("type") == "code" and isinstance(data.get("codeJS"), str):
                current = data["codeJS"]
                setter = lambda value, data=data: data.__setitem__("codeJS", value)  # noqa: E731
                where = f"code node {node_id}"
            elif not file and node_sources is not None and len(node_sources) == 1:
                only = next(iter(node_sources))
                current = node_sources[only]
                setter = lambda value, node_sources=node_sources, only=only: node_sources.__setitem__(only, value)  # noqa: E731
                where = f"node {node_id}/{only}"
            else:
                detail = (
                    f"files: {', '.join(node_sources.keys())}"
                    if node_sources is not None
                    else "no codeJS" if node.get("type") == "code" else "not a code node and no sources"
                )
                issues.append(f'Node "{node_id}" has no editable source{f" {json.dumps(file)}" if file else ""} ({detail}).')
    if current is None or setter is None:
        return scene, issues, ""

    working = current
    replacements = 0

    def not_found(index: int, label: str, text: str) -> str:
        first_line = text.split("\n")[0]
        return (
            f"edits[{index}]: {label} in {where}: {json.dumps(first_line[:80])}"
            f"{' (first line shown)' if chr(10) in text else ''}. Check whitespace and quote the text exactly as it appears."
        )

    for index, edit in enumerate(edits):
        find = edit.get("find")
        replace_value = edit.get("replace")
        replace = replace_value if isinstance(replace_value, str) else ""
        # A model often sends every property, the unused ones empty or null:
        # only text in from or to makes the edit a block.
        if edit.get("from") not in (None, "") or edit.get("to") not in (None, ""):
            # A block by its first and last lines: dead code, an old renderer,
            # a section too long to quote whole.
            start_text = edit.get("from")
            end_text = edit.get("to")
            if isinstance(find, str) and find:
                issues.append(f"edits[{index}]: give either find, or from and to, not both.")
                continue
            if not isinstance(start_text, str) or not start_text or not isinstance(end_text, str) or not end_text:
                issues.append(f"edits[{index}]: a block needs both from and to, each a non-empty string.")
                continue
            starts = working.count(start_text)
            if starts == 0:
                issues.append(not_found(index, "from not found", start_text))
                continue
            if starts > 1:
                issues.append(
                    f"edits[{index}]: from matches {starts} times in {where}; include more of the block's first lines."
                )
                continue
            start = working.find(start_text)
            # The first `to` that ends at or after the end of `from`, so a block
            # of one line may name the same text twice.
            end = working.find(end_text, max(start, start + len(start_text) - len(end_text)))
            if end < 0:
                issues.append(not_found(index, "to not found after from", end_text))
                continue
            working = working[:start] + replace + working[end + len(end_text):]
            replacements += 1
            continue
        if not isinstance(find, str) or not find:
            issues.append(f"edits[{index}]: find must be a non-empty string.")
            continue
        count = working.count(find)
        if count == 0:
            issues.append(not_found(index, "not found", find))
            continue
        if count > 1 and edit.get("all") is not True:
            issues.append(f"edits[{index}]: matches {count} times in {where}; include more surrounding text or set all: true.")
            continue
        working = working.replace(find, replace) if edit.get("all") is True else working.replace(find, replace, 1)
        replacements += count
    if issues:
        return copy.deepcopy(base), issues, ""
    setter(working)
    return scene, issues, f"{where}: {replacements} replacement(s), {len(current)} → {len(working)} chars"


def check_and_prepare_delivery(
    raw_scenes: Any,
    *,
    tool: str,
    current_scene: JsonObject | None,
    current_scene_id: str | None,
    known_keywords: set[str],
    rewrite: bool = False,
    split_state_nodes: Callable[[JsonObject], None] | None = None,
) -> tuple[JsonObject | None, JsonObject]:
    """Validate scenes the model delivers: (payload to emit or None, result for
    the model). `tool` is build_scene (create_scenes) or modify_scene
    (update_scene, patch_scene, edit_app_source)."""
    scenes = coerce_delivered_scenes(raw_scenes)
    if not scenes:
        again = (
            "Call create_scenes again with the complete scene JSON as `scenes`, an array of scene objects."
            if tool == "build_scene"
            else "Call update_scene again with the complete scene JSON as `scene`, a single scene object."
        )
        return None, {
            "ok": False,
            "issues": [
                "No scene arrived: the call carried no scene JSON, so nothing was validated and nothing reached the "
                "editor. This is not a judgement on the scene you wrote. " + again
            ],
        }
    payload: JsonObject = {"scenes": scenes}
    if tool == "modify_scene" and isinstance(scenes[0], dict):
        if current_scene_id:
            scenes[0]["id"] = current_scene_id
        if not scenes[0].get("name") and current_scene and current_scene.get("name"):
            scenes[0]["name"] = current_scene["name"]
    retire_apps_in_scenes(scenes)
    issues = [*validate_scene_payload(payload), *validate_app_keywords(payload, known_keywords)]
    if issues:
        return None, {"ok": False, "issues": issues}
    if tool == "modify_scene" and current_scene and not rewrite and isinstance(scenes[0], dict):
        partial = partial_scene_issue(current_scene, scenes[0])
        if partial:
            return None, {"ok": False, "issues": [partial]}
    bundled = bundle_repo_apps(payload)
    if split_state_nodes:
        split_state_nodes(payload)
    result: JsonObject = {
        "ok": True,
        "delivered": True,
        "note": "The scene is now in the user's editor as an unsaved change. Remind them to review it and press Save, "
        "or — only when they asked for it to go on the frame — save it there yourself with frame_scene_update / "
        "frame_scene_install.",
    }
    if bundled:
        result["bundledApps"] = bundled
        result["bundledNote"] = (
            "Repo JS apps were bundled into the scene's own apps map under their short keywords (as the runtime "
            "requires); the delivered scene uses those keywords."
        )
    return payload, result
