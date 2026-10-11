"""The project's saved scenes (the backend calls them templates: scenes
kept off any frame, to install later or export) and the scene catalog (the
bundled repositories plus the ones the project added — the FrameOS gallery
and the scene store's repository.json). Scene names here match the cloud's
tools where the meaning matches: scenes_list / scene_get / scene_create /
scene_update / scene_delete, store_browse / store_scene_get."""
from __future__ import annotations

import json
from typing import Any

from ..client import ToolContext
from ..protocol import McpServer
from ..registry import Tool
from ..result import McpInputError, run, text
from .frames import as_scene_list, compact_scene

TEMPLATE_ID = {"type": "string", "description": "Saved scene id from scenes_list."}


def compact_template(template: dict[str, Any], origin: str) -> dict[str, Any]:
    scenes = template.get("scenes") or []
    return {
        "id": template.get("id"),
        "name": template.get("name"),
        "description": template.get("description"),
        "scene_count": len(scenes) if isinstance(scenes, list) else 0,
        "scene_names": [scene.get("name") for scene in scenes if isinstance(scene, dict)] if isinstance(scenes, list) else [],
        "image_url": f"{origin}{template['image']}" if template.get("image") else None,
    }


def register_scene_tools(server: McpServer, ctx: ToolContext) -> None:
    api = ctx.api

    async def scenes_list(search: str | None = None, project_id: int | None = None):
        async def go():
            templates = await api.json("GET", "/api/templates", project_id=project_id)
            rows = [compact_template(template, ctx.public_origin) for template in templates]
            if search:
                needle = search.lower()
                rows = [row for row in rows if needle in json.dumps(row, default=str).lower()]
            return text({"scenes": rows, "count": len(rows)})

        return await run(go)

    server.tool(Tool(
        name="scenes_list",
        description="The project's saved scenes (templates): id, name, description, the scenes inside and a preview image URL. Install one on a frame with frame_scene_install(template_id).",
        properties={"search": {"type": "string"}},
        annotations={"readOnlyHint": True},
        handler=scenes_list,
    ))

    async def scene_get(template_id: str, full: bool = False, project_id: int | None = None):
        async def go():
            template = await api.json("GET", f"/api/templates/{template_id}", project_id=project_id)
            scenes = template.get("scenes") or []
            return text({
                **compact_template(template, ctx.public_origin),
                "config": template.get("config"),
                "scenes": scenes if full else [compact_scene(scene) for scene in scenes if isinstance(scene, dict)],
            })

        return await run(go)

    server.tool(Tool(
        name="scene_get",
        description="One saved scene with its scene summaries (apps, fields, settings); full=true returns the complete scene JSON — what scene_create and frame_scene_install take.",
        properties={"template_id": TEMPLATE_ID, "full": {"type": "boolean"}},
        required=["template_id"],
        annotations={"readOnlyHint": True},
        handler=scene_get,
    ))

    async def scene_create(
        name: str,
        scenes: Any = None,
        from_frame_id: int | None = None,
        scene_ids: list[str] | None = None,
        description: str | None = None,
        url: str | None = None,
        project_id: int | None = None,
    ):
        async def go():
            sources = [value for value in (scenes, from_frame_id, url) if value]
            if len(sources) != 1:
                raise McpInputError("Pass exactly one source: scenes, from_frame_id, or url.")
            if url:
                payload = await api.json("POST", "/api/templates", project_id=project_id, data={"url": url, "name": name, **({"description": description} if description else {})})
                return text(compact_template(payload, ctx.public_origin))
            body: dict[str, Any] = {"name": name}
            if description:
                body["description"] = description
            if from_frame_id is not None:
                frame = (await api.json("GET", f"/api/frames/{from_frame_id}", project_id=project_id))["frame"]
                frame_scenes = [scene for scene in (frame.get("scenes") or []) if isinstance(scene, dict)]
                if scene_ids:
                    frame_scenes = [scene for scene in frame_scenes if scene.get("id") in scene_ids]
                    missing = set(scene_ids) - {scene.get("id") for scene in frame_scenes}
                    if missing:
                        raise McpInputError(f"Not on frame {from_frame_id}: {', '.join(sorted(missing))}")
                if not frame_scenes:
                    raise McpInputError(f"Frame {from_frame_id} has no scenes to save.")
                body["scenes"] = frame_scenes
                body["from_frame_id"] = from_frame_id
                if len(frame_scenes) == 1:
                    body["image_scene_id"] = frame_scenes[0].get("id")
            else:
                body["scenes"] = as_scene_list(scenes)
            payload = await api.json("POST", "/api/templates", project_id=project_id, json=body)
            return text(compact_template(payload, ctx.public_origin))

        return await run(go)

    server.tool(Tool(
        name="scene_create",
        description=(
            "Save a scene to the project (a template) from scene JSON, from a frame's installed scenes "
            "(from_frame_id, optionally only scene_ids — the frame's last render becomes the preview), or "
            "from a url (scenes.json, FrameOS zip, or a scene store page). Saved scenes are not on any frame "
            "until frame_scene_install."
        ),
        properties={
            "name": {"type": "string", "minLength": 1, "maxLength": 256},
            "scenes": {"type": ["object", "array", "string"], "description": "Scene JSON: one scene, a list, or scenes.json text."},
            "from_frame_id": {"type": "integer"},
            "scene_ids": {"type": "array", "items": {"type": "string"}, "description": "With from_frame_id: only these scenes."},
            "description": {"type": "string"},
            "url": {"type": "string"},
        },
        required=["name"],
        handler=scene_create,
    ))

    async def scene_update(template_id: str, name: str | None = None, description: str | None = None, project_id: int | None = None):
        async def go():
            if name is None and description is None:
                raise McpInputError("Nothing to change: pass name and/or description.")
            # The route wants both keys (Optional, not defaulted): send the
            # current value for whichever one is not changing.
            current = await api.json("GET", f"/api/templates/{template_id}", project_id=project_id)
            body = {
                "name": name if name is not None else current.get("name"),
                "description": description if description is not None else current.get("description"),
            }
            payload = await api.json("PATCH", f"/api/templates/{template_id}", project_id=project_id, json=body)
            return text(compact_template(payload, ctx.public_origin))

        return await run(go)

    server.tool(Tool(
        name="scene_update",
        description="Rename a saved scene or change its description. The scene JSON itself is immutable here: scene_create a new one (or edit it on a frame with frame_scene_update).",
        properties={"template_id": TEMPLATE_ID, "name": {"type": "string", "maxLength": 256}, "description": {"type": "string"}},
        required=["template_id"],
        annotations={"idempotentHint": True},
        handler=scene_update,
    ))

    async def scene_delete(confirm: bool, template_id: str, project_id: int | None = None):
        return await run(lambda: _text(api, "DELETE", f"/api/templates/{template_id}", project_id))

    server.tool(Tool(
        name="scene_delete",
        description="Delete a saved scene from the project. Frames that have it installed keep their copy. Requires confirm=true.",
        properties={
            "confirm": {"type": "boolean", "const": True, "description": "Must be true — this cannot be undone."},
            "template_id": TEMPLATE_ID,
        },
        required=["confirm", "template_id"],
        annotations={"destructiveHint": True},
        handler=scene_delete,
    ))

    # -- catalog ------------------------------------------------------------

    async def store_browse(search: str | None = None, repository: str | None = None, project_id: int | None = None):
        async def go():
            system = await api.json("GET", "/api/repositories/system", scoped=False)
            project = await api.json("GET", "/api/repositories", project_id=project_id)
            rows = []
            for kind, repositories in (("system", system), ("project", project)):
                for repo in repositories or []:
                    repo_id = str(repo.get("id") or "")
                    # Bundled repositories are listed as `system-<slug>`; the
                    # scenes route takes the bare slug.
                    slug = repo_id[len("system-"):] if kind == "system" and repo_id.startswith("system-") else None
                    if repository and repository not in (slug, repo.get("name"), repo_id):
                        continue
                    for template in repo.get("templates") or []:
                        if not isinstance(template, dict):
                            continue
                        template_slug = template.get("id") or template.get("slug")
                        scenes_url = template.get("scenesUrl") or (
                            template.get("scenes") if isinstance(template.get("scenes"), str) else None
                        )
                        image = template.get("image")
                        row = {
                            "repository": repo.get("name"),
                            "repository_slug": slug,
                            "repository_id": repo_id,
                            "template_slug": template_slug,
                            "name": template.get("name"),
                            "description": template.get("description"),
                            "version": template.get("version"),
                            "zip_url": template.get("zip"),
                            "scenes_url": scenes_url,
                            "image_url": f"{ctx.public_origin}{image}" if isinstance(image, str) and image.startswith("/") else image,
                            "install": (
                                {"repository": slug, "template": template_slug}
                                if slug
                                else {"url": template.get("zip") or scenes_url}
                            ),
                        }
                        if search:
                            haystack = " ".join(str(value) for value in (row["name"], row["description"], row["repository"])).lower()
                            if search.lower() not in haystack:
                                continue
                        rows.append(row)
            return text({
                "templates": rows,
                "count": len(rows),
                "note": "Install with frame_scene_install using the `install` fields (repository+template for bundled ones, url for the rest).",
            })

        return await run(go)

    server.tool(Tool(
        name="store_browse",
        description=(
            "Browse the scene catalog: the bundled sample and gallery repositories plus the repositories the "
            "project added (the FrameOS Gallery and the scene store appear here when configured). Returns "
            "each template with its description, preview image and how to install it."
        ),
        properties={"search": {"type": "string"}, "repository": {"type": "string", "description": "Only this repository (slug, id or name)."}},
        annotations={"readOnlyHint": True},
        handler=store_browse,
    ))

    async def store_scene_get(repository: str, template: str, full: bool = False):
        async def go():
            scenes = await api.json("GET", f"/api/repositories/system/{repository}/templates/{template}/scenes.json", scoped=False)
            scene_list = as_scene_list(scenes)
            return text({
                "repository": repository,
                "template": template,
                "scenes": scene_list if full else [compact_scene(scene) for scene in scene_list],
            })

        return await run(go)

    server.tool(Tool(
        name="store_scene_get",
        description="The scenes of one bundled catalog template (store_browse rows with a repository_slug): summaries, or the full JSON with full=true.",
        properties={"repository": {"type": "string", "minLength": 1}, "template": {"type": "string", "minLength": 1}, "full": {"type": "boolean"}},
        required=["repository", "template"],
        annotations={"readOnlyHint": True},
        scoped=False,
        handler=store_scene_get,
    ))


async def _text(api, method: str, path: str, project_id: int | None, **kwargs: Any):
    return text(await api.json(method, path, project_id=project_id, **kwargs))
