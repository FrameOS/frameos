"""The frames of a project. Every call here is one of the `/api/frames`
routes; the few compound tools (install a scene then deploy, activate a scene
as the boot default) are two routes back to back and say so.

The backend is a push control plane: changing a frame's scenes or settings
edits the project's record of the frame, and a deploy (fast or full) carries
it to the device. The scene tools therefore take `deploy` and default to the
fast path — scenes and config pushed to the running runtime, no rebuild.
Device actions (restart, reboot, render, events) are pushed immediately."""
from __future__ import annotations

import base64
import binascii
import copy
import json
import uuid
from typing import Any

from ..client import ToolContext
from ..protocol import McpServer
from ..registry import Tool, confirmed
from ..result import McpInputError, failure, image, run, text

FRAME_ID = {"type": "integer", "description": "Frame id from frames_list."}
SCENE_ID = {"type": "string", "description": "Scene id from frame_scenes_list."}
DEPLOY = {
    "type": "string",
    "enum": ["fast", "full", "none"],
    "description": (
        "How to carry the change to the device: fast (default) pushes scenes and config to the running "
        "runtime; full is a complete deploy (also installs a newer FrameOS release); none saves it on the "
        "backend only, for a frame_deploy later."
    ),
}

# Keys of `POST /api/frames/{id}` a tool may set. The credentials the route
# also takes (ssh_pass, server_api_key, frame_access_key, frame_admin_auth,
# agent, https_proxy, network) stay in the web UI on purpose: a leaked token
# must not be able to reroute a frame's control connection.
FRAME_SETTING_KEYS = (
    "name", "archived", "width", "height", "rotate", "flip", "color", "timezone", "timezone_updater",
    "interval", "metrics_interval", "max_http_response_bytes", "log_to_file", "assets_path", "save_assets",
    "upload_fonts", "scaling_mode", "device", "device_config", "debug", "reboot", "control_code", "schedule",
    "gpio_buttons", "error_behavior", "input_settings", "palette", "colors", "service_setting_groups",
    "frame_host", "frame_port", "ssh_user", "ssh_port", "server_host", "server_port", "server_scheme",
    "server_send_logs", "mountpoints",
)

SECRET_FRAME_KEYS = ("ssh_pass", "server_api_key", "frame_access_key", "terminal_history")


def platform_of(frame: dict[str, Any]) -> str | None:
    mode = frame.get("mode") or "rpios"
    for key in ("embedded", "buildroot", "rpios"):
        block = frame.get(key)
        if mode == key and isinstance(block, dict) and block.get("platform"):
            return str(block["platform"])
    return None


def compact_frame(frame: dict[str, Any]) -> dict[str, Any]:
    scenes = frame.get("scenes") or []
    return {
        "id": frame.get("id"),
        "name": frame.get("name"),
        "mode": frame.get("mode") or "rpios",
        "platform": platform_of(frame),
        "device": frame.get("device"),
        "width": frame.get("width"),
        "height": frame.get("height"),
        "status": frame.get("status"),
        "archived": bool(frame.get("archived")),
        "frame_host": frame.get("frame_host"),
        "frameos_version": frame.get("version"),
        "interval": frame.get("interval"),
        "timezone": frame.get("timezone"),
        "scene_count": len(scenes) if isinstance(scenes, list) else 0,
        "active_scene_id": frame.get("active_scene_id"),
        "active_connections": frame.get("active_connections"),
        "last_log_at": frame.get("last_log_at"),
        "last_successful_deploy_at": frame.get("last_successful_deploy_at"),
    }


def redact_frame(frame: dict[str, Any]) -> dict[str, Any]:
    """frame_get without the credentials and the bulk: a model needs the
    settings, not the SSH password or the last deploy's full snapshot."""
    out = {key: value for key, value in frame.items() if key not in SECRET_FRAME_KEYS}
    admin_auth = out.get("frame_admin_auth")
    if isinstance(admin_auth, dict):
        out["frame_admin_auth"] = {key: value for key, value in admin_auth.items() if key != "pass"}
    agent = out.get("agent")
    if isinstance(agent, dict):
        out["agent"] = {key: ("<redacted>" if "secret" in key.lower() else value) for key, value in agent.items()}
    network = out.get("network")
    if isinstance(network, dict):
        out["network"] = {
            key: ("<redacted>" if "password" in key.lower() or "psk" in key.lower() else value)
            for key, value in network.items()
        }
    proxy = out.get("https_proxy")
    if isinstance(proxy, dict):
        out["https_proxy"] = {key: value for key, value in proxy.items() if key != "certs"}
    deploy = out.get("last_successful_deploy")
    if isinstance(deploy, dict):
        out["last_successful_deploy"] = {
            key: deploy.get(key) for key in ("build_kind", "version", "mode") if key in deploy
        }
    scenes = out.get("scenes")
    if isinstance(scenes, list):
        out["scenes"] = [
            {"id": scene.get("id"), "name": scene.get("name"), "default": bool(scene.get("default"))}
            for scene in scenes
            if isinstance(scene, dict)
        ]
        out["scenes_note"] = "Scene summaries only; frame_scenes_list has fields and apps, frame_scene_get the JSON."
    return out


def compact_scene(scene: dict[str, Any]) -> dict[str, Any]:
    nodes = scene.get("nodes") or []
    apps = sorted(
        {
            str(node.get("data", {}).get("keyword"))
            for node in nodes
            if isinstance(node, dict) and node.get("type") == "app" and isinstance(node.get("data"), dict)
            and node["data"].get("keyword")
        }
    )
    fields = [
        {key: field.get(key) for key in ("name", "label", "type", "value", "access", "persist") if key in field}
        for field in (scene.get("fields") or [])
        if isinstance(field, dict)
    ]
    return {
        "id": scene.get("id"),
        "name": scene.get("name"),
        "default": bool(scene.get("default")),
        "node_count": len(nodes),
        "apps": apps,
        "fields": fields,
        "settings": scene.get("settings") or {},
        "origin": scene.get("origin"),
    }


def duplicate_scenes(scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fresh ids for scenes copied onto a frame, with every reference to an
    old id (scene links in nodes, edges) rewritten — what the editor does
    when a template is applied (frameLogic.ts duplicateScenes)."""
    mapping = {str(scene.get("id")): str(uuid.uuid4()) for scene in scenes if scene.get("id")}

    def rewrite(value: Any) -> Any:
        # Exact string values only: a reference is a whole id (a scene node's
        # keyword, a `sceneId` config), never part of a longer string.
        if isinstance(value, str):
            return mapping.get(value, value)
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            return {key: rewrite(item) for key, item in value.items()}
        return value

    copied = [rewrite(scene) for scene in scenes]
    for scene in copied:
        scene.pop("default", None)
        if not scene.get("id"):
            scene["id"] = str(uuid.uuid4())
    return copied


def as_scene_list(value: Any) -> list[dict[str, Any]]:
    """Accepts a scene object, a list of scenes, a `{scenes: [...]}` wrapper
    or any of those as a JSON string."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as error:
            raise McpInputError(f"scenes is not valid JSON: {error}") from error
    if isinstance(value, dict) and isinstance(value.get("scenes"), list):
        value = value["scenes"]
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or not value or not all(isinstance(scene, dict) for scene in value):
        raise McpInputError("scenes must be a scene object or a non-empty list of scene objects")
    for scene in value:
        if not isinstance(scene.get("nodes"), list):
            raise McpInputError(f"scene {scene.get('id') or scene.get('name') or '?'} has no nodes list")
    return copy.deepcopy(value)


def register_frame_tools(server: McpServer, ctx: ToolContext) -> None:
    api = ctx.api

    async def get_frame(frame_id: int, project_id: int | None) -> dict[str, Any]:
        payload = await api.json("GET", f"/api/frames/{frame_id}", project_id=project_id)
        return payload["frame"]

    async def save_scenes(frame_id: int, scenes: list[dict[str, Any]], project_id: int | None) -> None:
        await api.json("POST", f"/api/frames/{frame_id}", project_id=project_id, json={"scenes": scenes})

    async def deploy_after(frame_id: int, deploy: str, project_id: int | None) -> dict[str, Any]:
        if deploy == "fast":
            return {"deploy": "fast", **(await api.json("POST", f"/api/frames/{frame_id}/fast_deploy", project_id=project_id))}
        if deploy == "full":
            return {"deploy": "full", **(await api.json("POST", f"/api/frames/{frame_id}/deploy", project_id=project_id))}
        return {"deploy": "none", "note": "Saved on the backend only; call frame_deploy to push it to the device."}

    # -- listing and reading ------------------------------------------------

    async def frames_list(project_id: int | None = None, include_archived: bool = False):
        async def go():
            payload = await api.json("GET", "/api/frames", project_id=project_id)
            frames = [compact_frame(frame) for frame in payload.get("frames", [])]
            if not include_archived:
                frames = [frame for frame in frames if not frame["archived"]]
            return text({"frames": frames, "workspace_url": f"{ctx.public_origin}/"})

        return await run(go)

    server.tool(Tool(
        name="frames_list",
        description=(
            "List the project's frames: id, name, mode (rpios/buildroot/embedded), platform, device, size, "
            "status, host, FrameOS version, interval, scene count, the scene currently showing and when "
            "the frame last logged. Archived frames are left out unless include_archived."
        ),
        properties={"include_archived": {"type": "boolean"}},
        annotations={"readOnlyHint": True},
        handler=frames_list,
    ))

    async def frame_get(frame_id: int, project_id: int | None = None):
        return await run(lambda: _frame_get(frame_id, project_id))

    async def _frame_get(frame_id: int, project_id: int | None):
        frame = await get_frame(frame_id, project_id)
        return text({"frame": redact_frame(frame), "workspace_url": f"{ctx.public_origin}/frames/{frame_id}"})

    server.tool(Tool(
        name="frame_get",
        description=(
            "Everything the backend records about one frame: connection (host, ports, mode), display "
            "(device, size, rotate, color palette, colors), timing (interval, timezone, schedule, reboot), "
            "scene summaries, error behavior, GPIO buttons, build/deploy state. Credentials are redacted."
        ),
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_get,
    ))

    async def frame_ping(frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/ping", project_id))

    server.tool(Tool(
        name="frame_ping",
        description="Probe the frame: whether the backend can reach its runtime, over which path (direct HTTP, agent), and what it answered.",
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_ping,
    ))

    async def frame_sync_status(frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/sync", project_id))

    server.tool(Tool(
        name="frame_sync_status",
        description="Compare the backend's record of the frame with what the device reports (config and scenes): which side is ahead, and what a deploy or a sync would change.",
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_sync_status,
    ))

    async def frame_state_get(frame_id: int, refresh: bool = False, project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/states", project_id, params={"refresh": "1" if refresh else None}))

    server.tool(Tool(
        name="frame_state_get",
        description="The scene currently showing (sceneId) and every scene's public state fields as the runtime holds them. refresh=true asks the device instead of the backend's cache.",
        properties={"frame_id": FRAME_ID, "refresh": {"type": "boolean"}},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_state_get,
    ))

    # -- creating, updating, deleting ---------------------------------------

    async def frame_create(
        name: str,
        frame_host: str,
        server_host: str,
        mode: str | None = None,
        device: str | None = None,
        platform: str | None = None,
        interval: float | None = None,
        timezone: str | None = None,
        project_id: int | None = None,
    ):
        async def go():
            body = {
                key: value
                for key, value in {
                    "name": name, "frame_host": frame_host, "server_host": server_host, "mode": mode,
                    "device": device, "platform": platform, "interval": interval, "timezone": timezone,
                }.items()
                if value is not None
            }
            payload = await api.json("POST", "/api/frames/new", project_id=project_id, json=body)
            frame = payload["frame"]
            return text({
                "frame": compact_frame(frame),
                "next": "Set credentials (SSH password or keys) in the web UI, then frame_deploy to install FrameOS.",
                "workspace_url": f"{ctx.public_origin}/frames/{frame['id']}",
            })

        return await run(go)

    server.tool(Tool(
        name="frame_create",
        description=(
            "Register a new frame in the project. frame_host is how the backend reaches it (`host`, `user@host`, "
            "`user:password@host:port`); server_host is how the frame reaches this backend. mode: rpios "
            "(Raspberry Pi OS, default), buildroot (FrameOS SD image) or embedded (ESP32). The device name "
            "picks the display driver (e.g. pimoroni.inky_impression_13, waveshare.epd_7in5_v2, web_only)."
        ),
        properties={
            "name": {"type": "string", "minLength": 1, "maxLength": 256},
            "frame_host": {"type": "string", "minLength": 1},
            "server_host": {"type": "string", "minLength": 1},
            "mode": {"type": "string", "enum": ["rpios", "buildroot", "embedded"]},
            "device": {"type": "string"},
            "platform": {"type": "string", "description": "Board for buildroot/embedded modes (e.g. pi-zero-2w, esp32-s3-generic)."},
            "interval": {"type": "number", "minimum": 1},
            "timezone": {"type": "string", "description": "IANA zone, e.g. Europe/Brussels."},
        },
        required=["name", "frame_host", "server_host"],
        handler=frame_create,
    ))

    async def frame_update(
        confirm: bool,
        frame_id: int,
        settings: dict[str, Any],
        then: str = "none",
        project_id: int | None = None,
    ):
        async def go():
            unknown = sorted(set(settings) - set(FRAME_SETTING_KEYS))
            if unknown:
                raise McpInputError(
                    f"Not settable through this tool: {', '.join(unknown)}. Allowed: {', '.join(FRAME_SETTING_KEYS)}"
                )
            if not settings:
                raise McpInputError("settings is empty")
            body: dict[str, Any] = dict(settings)
            if then in ("restart", "reboot", "deploy"):
                body["next_action"] = then
            result = await api.json("POST", f"/api/frames/{frame_id}", project_id=project_id, json=body)
            if then == "fast_deploy":
                result = {**result, **(await deploy_after(frame_id, "fast", project_id))}
            elif then == "deploy":
                result = {**result, "deploy": "full"}
            elif then in ("restart", "reboot"):
                result = {**result, "then": then}
            else:
                result = {**result, "note": "Saved on the backend; a fast or full deploy carries it to the device."}
            frame = await get_frame(frame_id, project_id)
            return text({**result, "frame": compact_frame(frame)})

        return await run(go)

    server.tool(Tool(
        name="frame_update",
        description=(
            "Change a frame's settings on the backend, optionally pushing them. Requires confirm=true. "
            "`settings` holds only the keys to change: " + ", ".join(FRAME_SETTING_KEYS) + ". "
            "`then` carries it to the device: none (default; deploy later), fast_deploy (push config and "
            "scenes to the running runtime), deploy (full), restart, reboot. Credentials (SSH password, "
            "admin login, agent secret, Wi-Fi) are not settable here."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame does or shows"),
            "frame_id": FRAME_ID,
            "settings": {"type": "object"},
            "then": {"type": "string", "enum": ["none", "fast_deploy", "deploy", "restart", "reboot"]},
        },
        required=["confirm", "frame_id", "settings"],
        annotations={"idempotentHint": True},
        handler=frame_update,
    ))

    async def frame_rename(frame_id: int, name: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}", project_id, json={"name": name}))

    server.tool(Tool(
        name="frame_rename",
        description="Rename a frame (1–256 characters). Backend-side only; the device learns it on the next deploy.",
        properties={"frame_id": FRAME_ID, "name": {"type": "string", "minLength": 1, "maxLength": 256}},
        required=["frame_id", "name"],
        annotations={"idempotentHint": True},
        handler=frame_rename,
    ))

    async def frame_delete(confirm: bool, frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "DELETE", f"/api/frames/{frame_id}", project_id))

    server.tool(Tool(
        name="frame_delete",
        description=(
            "Permanently delete a frame from the project: its record, logs, metrics and scene images. The "
            "device itself keeps running whatever it last had. Prefer frame_update {archived: true} to hide a "
            "frame without losing its history. Requires confirm=true."
        ),
        properties={"confirm": {"type": "boolean", "const": True, "description": "Must be true — this cannot be undone."}, "frame_id": FRAME_ID},
        required=["confirm", "frame_id"],
        annotations={"destructiveHint": True},
        handler=frame_delete,
    ))

    # -- scenes -------------------------------------------------------------

    async def frame_scenes_list(frame_id: int, project_id: int | None = None):
        async def go():
            frame = await get_frame(frame_id, project_id)
            scenes = [compact_scene(scene) for scene in (frame.get("scenes") or []) if isinstance(scene, dict)]
            return text({
                "frame_id": frame_id,
                "active_scene_id": frame.get("active_scene_id"),
                "scenes": scenes,
                "editor_url": f"{ctx.public_origin}/frames/{frame_id}",
            })

        return await run(go)

    server.tool(Tool(
        name="frame_scenes_list",
        description=(
            "The scenes installed on a frame: id, name, whether it is the boot default, the apps it uses, "
            "its state fields (name, type, current value) and settings (refresh interval, background), plus "
            "which scene is showing now. frame_scene_get returns a scene's full JSON."
        ),
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_scenes_list,
    ))

    async def frame_scene_get(frame_id: int, scene_id: str, project_id: int | None = None):
        async def go():
            frame = await get_frame(frame_id, project_id)
            for scene in frame.get("scenes") or []:
                if isinstance(scene, dict) and scene.get("id") == scene_id:
                    return text(scene)
            raise McpInputError(f"Scene {scene_id} is not on frame {frame_id}; frame_scenes_list has the ids.")

        return await run(go)

    server.tool(Tool(
        name="frame_scene_get",
        description="One installed scene's full JSON (nodes, edges, fields, settings) — the shape frame_scene_update and frame_scene_install take.",
        properties={"frame_id": FRAME_ID, "scene_id": SCENE_ID},
        required=["frame_id", "scene_id"],
        annotations={"readOnlyHint": True},
        handler=frame_scene_get,
    ))

    async def resolve_scene_source(
        scenes: Any,
        template_id: str | None,
        repository: str | None,
        template: str | None,
        url: str | None,
        project_id: int | None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        sources = [value for value in (scenes, template_id, repository or template, url) if value]
        if len(sources) != 1:
            raise McpInputError("Pass exactly one source: scenes, template_id, repository+template, or url.")
        if scenes is not None:
            return as_scene_list(scenes), {"source": "scenes"}
        if template_id:
            payload = await api.json("GET", f"/api/templates/{template_id}", project_id=project_id)
            return as_scene_list(payload.get("scenes")), {"source": "template", "template_id": template_id, "name": payload.get("name")}
        if repository or template:
            if not (repository and template):
                raise McpInputError("repository and template go together (slugs from store_browse).")
            payload = await api.json(
                "GET", f"/api/repositories/system/{repository}/templates/{template}/scenes.json", scoped=False
            )
            return as_scene_list(payload), {"source": "repository", "repository": repository, "template": template}
        # A zip, a scenes.json or a store page: the template route fetches it
        # (SSRF-guarded) and keeps a copy in the project's saved scenes.
        payload = await api.json("POST", "/api/templates", project_id=project_id, data={"url": url})
        return as_scene_list(payload.get("scenes")), {
            "source": "url", "url": url, "saved_as_template_id": payload.get("id"), "name": payload.get("name"),
        }

    async def frame_scene_install(
        confirm: bool,
        frame_id: int,
        scenes: Any = None,
        template_id: str | None = None,
        repository: str | None = None,
        template: str | None = None,
        url: str | None = None,
        name: str | None = None,
        activate: bool = False,
        preserve_ids: bool = False,
        deploy: str = "fast",
        project_id: int | None = None,
    ):
        async def go():
            new_scenes, origin = await resolve_scene_source(scenes, template_id, repository, template, url, project_id)
            frame = await get_frame(frame_id, project_id)
            existing = [scene for scene in (frame.get("scenes") or []) if isinstance(scene, dict)]
            existing_ids = {scene.get("id") for scene in existing}
            if preserve_ids:
                skipped = [scene.get("id") for scene in new_scenes if scene.get("id") in existing_ids]
                new_scenes[:] = [scene for scene in new_scenes if scene.get("id") not in existing_ids]
                for scene in new_scenes:
                    scene.pop("default", None)
            else:
                skipped = []
                new_scenes[:] = duplicate_scenes(new_scenes)
            if name and len(new_scenes) == 1:
                new_scenes[0]["name"] = name
            if not new_scenes:
                raise McpInputError(f"Nothing to install: these scene ids are already on the frame ({', '.join(map(str, skipped))}).")
            await save_scenes(frame_id, existing + new_scenes, project_id)
            result: dict[str, Any] = {
                "installed": [{"id": scene.get("id"), "name": scene.get("name")} for scene in new_scenes],
                "skipped_existing": skipped,
                **origin,
            }
            if activate:
                result["activated"] = new_scenes[0].get("id")
                result.update(await api.json(
                    "POST", f"/api/frames/{frame_id}/set_next_scene", project_id=project_id,
                    json={"sceneId": new_scenes[0].get("id"), "fastDeploy": deploy != "full"},
                ))
                result["deploy"] = "none" if deploy == "none" else deploy
                if deploy == "none":
                    result["note"] = "activate needs a deploy; a fast deploy was queued despite deploy=none."
            else:
                result.update(await deploy_after(frame_id, deploy, project_id))
            return text(result)

        return await run(go)

    server.tool(Tool(
        name="frame_scene_install",
        description=(
            "Add scenes to a frame from one source: `scenes` (scene JSON: one object, a list, or scenes.json "
            "text), `template_id` (a saved scene from scenes_list), `repository` + `template` (catalog slugs "
            "from store_browse), or `url` (a scenes.json, a FrameOS zip, or a scene store page; the copy is "
            "also saved to the project's scenes). Scene ids are regenerated so a template can be installed "
            "twice (preserve_ids keeps them and skips ids already present). activate=true also makes the "
            "first new scene the boot default and shows it. Requires confirm=true: it deploys to the device "
            "(deploy: fast/full/none)."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame shows"),
            "frame_id": FRAME_ID,
            "scenes": {"type": ["object", "array", "string"], "description": "Scene JSON to install."},
            "template_id": {"type": "string"},
            "repository": {"type": "string", "description": "Catalog repository slug (store_browse)."},
            "template": {"type": "string", "description": "Catalog template slug (store_browse)."},
            "url": {"type": "string", "description": "https:// URL of a scenes.json, zip or scene store page."},
            "name": {"type": "string", "description": "Name for the scene when exactly one is installed."},
            "activate": {"type": "boolean"},
            "preserve_ids": {"type": "boolean"},
            "deploy": DEPLOY,
        },
        required=["confirm", "frame_id"],
        handler=frame_scene_install,
    ))

    async def frame_scene_update(
        confirm: bool, frame_id: int, scene: Any, deploy: str = "fast", project_id: int | None = None
    ):
        async def go():
            updated = as_scene_list(scene)
            if len(updated) != 1:
                raise McpInputError("scene must be exactly one scene object")
            new_scene = updated[0]
            frame = await get_frame(frame_id, project_id)
            scenes = [s for s in (frame.get("scenes") or []) if isinstance(s, dict)]
            index = next((i for i, s in enumerate(scenes) if s.get("id") == new_scene.get("id")), None)
            if index is None:
                raise McpInputError(f"Scene {new_scene.get('id')} is not on frame {frame_id}; frame_scene_install adds new ones.")
            if "default" not in new_scene and scenes[index].get("default"):
                new_scene["default"] = True
            scenes[index] = new_scene
            await save_scenes(frame_id, scenes, project_id)
            return text({"updated": {"id": new_scene.get("id"), "name": new_scene.get("name")}, **(await deploy_after(frame_id, deploy, project_id))})

        return await run(go)

    server.tool(Tool(
        name="frame_scene_update",
        description=(
            "Replace one installed scene's JSON (same id; get it with frame_scene_get, edit, send back). "
            "Requires confirm=true: it deploys to the device (deploy: fast/full/none)."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame shows"),
            "frame_id": FRAME_ID,
            "scene": {"type": ["object", "string"], "description": "The full scene object."},
            "deploy": DEPLOY,
        },
        required=["confirm", "frame_id", "scene"],
        handler=frame_scene_update,
    ))

    async def frame_scene_remove(
        confirm: bool, frame_id: int, scene_id: str, deploy: str = "fast", project_id: int | None = None
    ):
        async def go():
            frame = await get_frame(frame_id, project_id)
            scenes = [s for s in (frame.get("scenes") or []) if isinstance(s, dict)]
            remaining = [s for s in scenes if s.get("id") != scene_id]
            if len(remaining) == len(scenes):
                raise McpInputError(f"Scene {scene_id} is not on frame {frame_id}.")
            await save_scenes(frame_id, remaining, project_id)
            return text({"removed": scene_id, "remaining": len(remaining), **(await deploy_after(frame_id, deploy, project_id))})

        return await run(go)

    server.tool(Tool(
        name="frame_scene_remove",
        description="Remove one scene from a frame. Requires confirm=true: it deploys to the device (deploy: fast/full/none). The project's saved scenes (templates) are untouched.",
        properties={"confirm": confirmed(), "frame_id": FRAME_ID, "scene_id": SCENE_ID, "deploy": DEPLOY},
        required=["confirm", "frame_id", "scene_id"],
        annotations={"destructiveHint": True},
        handler=frame_scene_remove,
    ))

    async def frame_scene_activate(
        confirm: bool,
        frame_id: int,
        scene_id: str,
        state: dict[str, Any] | None = None,
        boot_default: bool = False,
        project_id: int | None = None,
    ):
        async def go():
            if boot_default:
                payload = await api.json(
                    "POST", f"/api/frames/{frame_id}/set_next_scene", project_id=project_id,
                    json={"sceneId": scene_id, "state": state, "fastDeploy": True},
                )
                return text({"activated": scene_id, "boot_default": True, **payload})
            body: dict[str, Any] = {"sceneId": scene_id}
            if state:
                body["state"] = state
            await api.json("POST", f"/api/frames/{frame_id}/event/setCurrentScene", project_id=project_id, json=body)
            return text({"activated": scene_id, "boot_default": False, "note": "Switched now; the frame returns to its boot default on restart unless boot_default=true."})

        return await run(go)

    server.tool(Tool(
        name="frame_scene_activate",
        description=(
            "Show one of the frame's scenes now (setCurrentScene), optionally with state field values. "
            "boot_default=true also makes it the scene the frame boots into (a fast deploy). Requires confirm=true."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame shows"),
            "frame_id": FRAME_ID,
            "scene_id": SCENE_ID,
            "state": {"type": "object", "description": "State field values to apply, by field name."},
            "boot_default": {"type": "boolean"},
        },
        required=["confirm", "frame_id", "scene_id"],
        handler=frame_scene_activate,
    ))

    async def frame_scene_state_set(
        confirm: bool, frame_id: int, state: dict[str, Any], scene_id: str | None = None, project_id: int | None = None
    ):
        async def go():
            body: dict[str, Any] = {"state": state}
            if scene_id:
                body["sceneId"] = scene_id
            await api.json("POST", f"/api/frames/{frame_id}/event/setSceneState", project_id=project_id, json=body)
            return text({"ok": True, "scene_id": scene_id or "current", "state": state})

        return await run(go)

    server.tool(Tool(
        name="frame_scene_state_set",
        description="Set public state fields of a scene (the current one, or scene_id) and re-render. Field names come from frame_scenes_list. Requires confirm=true.",
        properties={
            "confirm": confirmed("changes what a physical frame shows"),
            "frame_id": FRAME_ID,
            "state": {"type": "object"},
            "scene_id": {"type": "string"},
        },
        required=["confirm", "frame_id", "state"],
        handler=frame_scene_state_set,
    ))

    async def frame_render(confirm: bool, frame_id: int, project_id: int | None = None):
        async def go():
            await api.json("POST", f"/api/frames/{frame_id}/event/render", project_id=project_id, json={})
            return text({"ok": True, "note": "Render requested; frame_screenshot shows the result once the display has refreshed."})

        return await run(go)

    server.tool(Tool(
        name="frame_render",
        description="Ask the frame to render its current scene now. Requires confirm=true (an e-paper refresh is visible and wears the panel).",
        properties={"confirm": confirmed("changes what a physical frame shows"), "frame_id": FRAME_ID},
        required=["confirm", "frame_id"],
        handler=frame_render,
    ))

    async def frame_event(
        confirm: bool, frame_id: int, event: str, payload: dict[str, Any] | None = None, project_id: int | None = None
    ):
        async def go():
            await api.json("POST", f"/api/frames/{frame_id}/event/{event}", project_id=project_id, json=payload or {})
            return text({"ok": True, "event": event})

        return await run(go)

    server.tool(Tool(
        name="frame_event",
        description=(
            "Send a named event to the frame's runtime with a JSON payload: the generic path behind "
            "frame_render / frame_scene_activate / frame_scene_state_set, for events a scene defines itself "
            "(custom events) or runtime events like reload. Requires confirm=true."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame does"),
            "frame_id": FRAME_ID,
            "event": {"type": "string", "minLength": 1, "maxLength": 128},
            "payload": {"type": "object"},
        },
        required=["confirm", "frame_id", "event"],
        handler=frame_event,
    ))

    # -- images, logs, metrics ----------------------------------------------

    async def frame_screenshot(frame_id: int, project_id: int | None = None):
        async def go():
            pid = await api.project_id(project_id)
            body, content_type = await api.bytes("GET", f"/api/projects/{pid}/frames/{frame_id}/image", scoped=False)
            mime = content_type.split(";")[0].strip() or "image/png"
            if not mime.startswith("image/"):
                return failure(f"The frame returned {mime} instead of an image")
            return image(body, mime, f"Frame {frame_id}: what the display last rendered ({len(body)} bytes)")

        return await run(go)

    server.tool(Tool(
        name="frame_screenshot",
        description="The image the frame last rendered (fetched from the device, or the copy the device pushed). Returns the image.",
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_screenshot,
    ))

    async def frame_scene_preview(frame_id: int, scene_id: str, thumbnail: bool = False, project_id: int | None = None):
        async def go():
            pid = await api.project_id(project_id)
            body, content_type = await api.bytes(
                "GET", f"/api/projects/{pid}/frames/{frame_id}/scene_images/{scene_id}", scoped=False,
                params={"thumb": "1" if thumbnail else None},
            )
            mime = content_type.split(";")[0].strip() or "image/png"
            if not mime.startswith("image/"):
                return failure(f"Scene image route returned {mime}")
            return image(body, mime, f"Scene {scene_id} on frame {frame_id}: last stored render (a placeholder when none exists)")

        return await run(go)

    server.tool(Tool(
        name="frame_scene_preview",
        description="The last stored render of one scene on a frame (a sized placeholder when it has never rendered). Returns the image.",
        properties={"frame_id": FRAME_ID, "scene_id": SCENE_ID, "thumbnail": {"type": "boolean"}},
        required=["frame_id", "scene_id"],
        annotations={"readOnlyHint": True},
        handler=frame_scene_preview,
    ))

    async def frame_logs(
        frame_id: int, limit: int = 100, search: str | None = None, type: str | None = None, project_id: int | None = None
    ):
        async def go():
            payload = await api.json("GET", f"/api/frames/{frame_id}/logs", project_id=project_id)
            logs = payload.get("logs") or []
            if type:
                logs = [entry for entry in logs if entry.get("type") == type]
            if search:
                needle = search.lower()
                logs = [entry for entry in logs if needle in json.dumps(entry.get("line"), default=str).lower()]
            total = len(logs)
            logs = logs[-limit:]
            return text({"frame_id": frame_id, "matched": total, "returned": len(logs), "logs": logs})

        return await run(go)

    server.tool(Tool(
        name="frame_logs",
        description=(
            "The frame's recent log lines (newest last) from the backend's log store: runtime events as "
            "JSON (render:done, error:…, sleep forecasts), deploy output, and the backend's own notes. "
            "`search` filters case-insensitively, `type` by stream (stdout, stderr, webhook, agent)."
        ),
        properties={
            "frame_id": FRAME_ID,
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
            "search": {"type": "string"},
            "type": {"type": "string"},
        },
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_logs,
    ))

    async def frame_metrics(frame_id: int, limit: int = 100, project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/metrics/recent", project_id, params={"limit": limit}))

    server.tool(Tool(
        name="frame_metrics",
        description="Recent metrics samples the frame reported (CPU, memory, temperature, battery, uptime…), oldest first, with reboot markers.",
        properties={"frame_id": FRAME_ID, "limit": {"type": "integer", "minimum": 1, "maximum": 1000}},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_metrics,
    ))

    # -- power and deploys --------------------------------------------------

    def power_tool(name: str, path: str, description: str) -> None:
        async def handler(confirm: bool, frame_id: int, project_id: int | None = None):
            async def go():
                payload = await api.json("POST", f"/api/frames/{frame_id}/{path}", project_id=project_id)
                return text({"ok": True, "result": payload})

            return await run(go)

        server.tool(Tool(
            name=name,
            description=description,
            properties={"confirm": confirmed("changes what a physical frame does"), "frame_id": FRAME_ID},
            required=["confirm", "frame_id"],
            handler=handler,
        ))

    power_tool("frame_restart", "restart", "Restart the FrameOS runtime on the frame (the service, not the board). Requires confirm=true.")
    power_tool("frame_reboot", "reboot", "Reboot the frame's board. Requires confirm=true.")
    power_tool("frame_stop", "stop", "Stop the FrameOS runtime on a Linux frame (not available for embedded or admin-API-only frames). Requires confirm=true.")

    async def frame_deploy(confirm: bool, frame_id: int, mode: str = "fast", force: bool = False, project_id: int | None = None):
        async def go():
            path = "fast_deploy" if mode == "fast" else "deploy"
            payload = await api.json("POST", f"/api/frames/{frame_id}/{path}", project_id=project_id, params={"force": "1" if force else None})
            return text({"mode": mode, **payload, "note": "Deploys run in the worker; frame_logs shows progress."})

        return await run(go)

    server.tool(Tool(
        name="frame_deploy",
        description=(
            "Push the backend's record of the frame to the device. mode fast (default): scenes and config "
            "to the running runtime, seconds; full: the complete deploy, which also installs a newer FrameOS "
            "release and the frame's drivers. force=true cancels a deploy already running. Requires confirm=true."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame does or shows"),
            "frame_id": FRAME_ID,
            "mode": {"type": "string", "enum": ["fast", "full"]},
            "force": {"type": "boolean"},
        },
        required=["confirm", "frame_id"],
        handler=frame_deploy,
    ))

    async def frame_deploy_plan(frame_id: int, mode: str = "combined", project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/deploy_plan", project_id, params={"mode": mode}))

    server.tool(Tool(
        name="frame_deploy_plan",
        description="What a deploy would do without doing it: the steps, the release it would install, and notes (mode: combined, full or fast).",
        properties={"frame_id": FRAME_ID, "mode": {"type": "string", "enum": ["combined", "full", "fast"]}},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_deploy_plan,
    ))

    async def frame_deploy_cancel(frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}/cancel_deploy", project_id))

    server.tool(Tool(
        name="frame_deploy_cancel",
        description="Cancel the deploy currently running for a frame.",
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        handler=frame_deploy_cancel,
    ))

    async def frame_commands_list(frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "GET", f"/api/frames/{frame_id}/commands", project_id))

    server.tool(Tool(
        name="frame_commands_list",
        description="Actions still waiting for the frame to pick them up. The backend pushes most actions immediately, so this is usually empty; a queued embedded OTA request shows here.",
        properties={"frame_id": FRAME_ID},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_commands_list,
    ))

    async def frame_command_cancel(frame_id: int, command_id: str, project_id: int | None = None):
        return await run(lambda: _json(api, "DELETE", f"/api/frames/{frame_id}/commands/{command_id}", project_id))

    server.tool(Tool(
        name="frame_command_cancel",
        description="Drop a pending action from frame_commands_list before the frame picks it up.",
        properties={"frame_id": FRAME_ID, "command_id": {"type": "string"}},
        required=["frame_id", "command_id"],
        handler=frame_command_cancel,
    ))

    # -- assets -------------------------------------------------------------

    async def frame_assets_list(frame_id: int, folder: str | None = None, refresh: bool = False, project_id: int | None = None):
        return await run(lambda: _json(
            api, "GET", f"/api/frames/{frame_id}/assets", project_id,
            params={"folder": folder, "refresh": "1" if refresh else None},
        ))

    server.tool(Tool(
        name="frame_assets_list",
        description="Files under the frame's assets folder (/srv/assets on Linux, the SD card on an ESP32): path, size, mtime, is_dir. `folder` lists one folder; refresh=true asks the device instead of the cache.",
        properties={"frame_id": FRAME_ID, "folder": {"type": "string"}, "refresh": {"type": "boolean"}},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_assets_list,
    ))

    async def frame_asset_get(frame_id: int, path: str, project_id: int | None = None):
        async def go():
            pid = await api.project_id(project_id)
            body, content_type = await api.bytes(
                "GET", f"/api/projects/{pid}/frames/{frame_id}/asset", scoped=False, params={"path": path}
            )
            mime = content_type.split(";")[0].strip() or "application/octet-stream"
            if mime.startswith("image/"):
                return image(body, mime, f"{path} ({len(body)} bytes)")
            if mime.startswith("text/") or mime in ("application/json", "application/javascript"):
                decoded = body.decode("utf-8", errors="replace")
                if len(decoded) > 64_000:
                    decoded = decoded[:64_000] + f"\n… truncated ({len(body)} bytes in all)"
                return text(decoded)
            if len(body) <= 256_000:
                return text({"path": path, "content_type": mime, "size": len(body), "base64": base64.b64encode(body).decode()})
            return text({"path": path, "content_type": mime, "size": len(body), "note": "Binary file over 256 KB: not returned inline."})

        return await run(go)

    server.tool(Tool(
        name="frame_asset_get",
        description="Read one asset file from the frame: images come back as an image, text as text, other small files base64-encoded.",
        properties={"frame_id": FRAME_ID, "path": {"type": "string", "description": "Path relative to the assets folder."}},
        required=["frame_id", "path"],
        annotations={"readOnlyHint": True},
        handler=frame_asset_get,
    ))

    async def frame_asset_upload(
        confirm: bool,
        frame_id: int,
        filename: str,
        content_base64: str | None = None,
        text_content: str | None = None,
        folder: str = "",
        project_id: int | None = None,
    ):
        async def go():
            if (content_base64 is None) == (text_content is None):
                raise McpInputError("Pass exactly one of content_base64 or text_content.")
            if content_base64 is not None:
                try:
                    data = base64.b64decode(content_base64, validate=True)
                except (binascii.Error, ValueError) as error:
                    raise McpInputError(f"content_base64 is not valid base64: {error}") from error
            else:
                data = (text_content or "").encode("utf-8")
            payload = await api.json(
                "POST", f"/api/frames/{frame_id}/assets/upload", project_id=project_id,
                data={"path": folder}, files={"file": (filename, data)},
            )
            return text(payload)

        return await run(go)

    server.tool(Tool(
        name="frame_asset_upload",
        description="Write a file into the frame's assets folder (optionally under `folder`), from base64 bytes or text. Requires confirm=true.",
        properties={
            "confirm": confirmed("changes what a physical frame stores"),
            "frame_id": FRAME_ID,
            "filename": {"type": "string", "minLength": 1},
            "content_base64": {"type": "string"},
            "text_content": {"type": "string"},
            "folder": {"type": "string", "description": "Folder relative to the assets root; empty for the root."},
        },
        required=["confirm", "frame_id", "filename"],
        handler=frame_asset_upload,
    ))

    async def frame_asset_delete(confirm: bool, frame_id: int, path: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}/assets/delete", project_id, data={"path": path}))

    server.tool(Tool(
        name="frame_asset_delete",
        description="Delete a file or folder from the frame's assets. Requires confirm=true.",
        properties={"confirm": confirmed(), "frame_id": FRAME_ID, "path": {"type": "string", "minLength": 1}},
        required=["confirm", "frame_id", "path"],
        annotations={"destructiveHint": True},
        handler=frame_asset_delete,
    ))

    async def frame_asset_mkdir(confirm: bool, frame_id: int, path: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}/assets/mkdir", project_id, data={"path": path}))

    server.tool(Tool(
        name="frame_asset_mkdir",
        description="Create a folder under the frame's assets. Requires confirm=true.",
        properties={"confirm": confirmed("changes what a physical frame stores"), "frame_id": FRAME_ID, "path": {"type": "string", "minLength": 1}},
        required=["confirm", "frame_id", "path"],
        handler=frame_asset_mkdir,
    ))

    async def frame_asset_rename(confirm: bool, frame_id: int, src: str, dst: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}/assets/rename", project_id, data={"src": src, "dst": dst}))

    server.tool(Tool(
        name="frame_asset_rename",
        description="Rename or move a file or folder under the frame's assets. Requires confirm=true.",
        properties={
            "confirm": confirmed("changes what a physical frame stores"),
            "frame_id": FRAME_ID,
            "src": {"type": "string", "minLength": 1},
            "dst": {"type": "string", "minLength": 1},
        },
        required=["confirm", "frame_id", "src", "dst"],
        handler=frame_asset_rename,
    ))

    async def frame_assets_sync_fonts(confirm: bool, frame_id: int, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", f"/api/frames/{frame_id}/assets/sync", project_id))

    server.tool(Tool(
        name="frame_assets_sync_fonts",
        description="Upload the project's fonts (the bundled ones plus custom uploads) onto the frame's assets, so scenes can use them by name. Requires confirm=true.",
        properties={"confirm": confirmed("changes what a physical frame stores"), "frame_id": FRAME_ID},
        required=["confirm", "frame_id"],
        handler=frame_assets_sync_fonts,
    ))

    # -- firmware -----------------------------------------------------------

    async def frame_firmware_info(frame_id: int, check: bool = True, project_id: int | None = None):
        async def go():
            frame = await get_frame(frame_id, project_id)
            result: dict[str, Any] = {
                "frame_id": frame_id,
                "mode": frame.get("mode") or "rpios",
                "platform": platform_of(frame),
                "frameos_version": frame.get("version"),
            }
            try:
                result["latest_release"] = await api.json("GET", "/api/frames/firmware", project_id=project_id)
            except Exception as error:  # noqa: BLE001 — the release lookup is a network call
                result["latest_release_error"] = str(error)
            if (frame.get("mode") or "rpios") != "embedded":
                try:
                    result["device"] = await api.json(
                        "GET", f"/api/frames/{frame_id}/device/upgrade", project_id=project_id,
                        params={"check": "1" if check else None},
                    )
                except Exception as error:  # noqa: BLE001 — an offline frame has no upgrade status
                    result["device_error"] = str(error)
            return text(result)

        return await run(go)

    server.tool(Tool(
        name="frame_firmware_info",
        description="The frame's FrameOS version against the latest signed release, and (Linux frames) the device's own upgrade status; check=true asks the device to look up the latest release.",
        properties={"frame_id": FRAME_ID, "check": {"type": "boolean"}},
        required=["frame_id"],
        annotations={"readOnlyHint": True},
        handler=frame_firmware_info,
    ))

    async def frame_firmware_update(confirm: bool, frame_id: int, dry_run: bool = False, project_id: int | None = None):
        async def go():
            frame = await get_frame(frame_id, project_id)
            if (frame.get("mode") or "rpios") == "embedded":
                if dry_run:
                    return text({"dry_run": True, "note": "Embedded frames have no dry run; frame_firmware_info shows the versions."})
                return text(await api.json("POST", f"/api/frames/{frame_id}/embedded/firmware/ota", project_id=project_id))
            return text(await api.json(
                "POST", f"/api/frames/{frame_id}/device/upgrade", project_id=project_id, json={"dry_run": dry_run},
            ))

        return await run(go)

    server.tool(Tool(
        name="frame_firmware_update",
        description=(
            "Update the frame to the latest signed FrameOS release: an ESP32 is asked to install it over the "
            "air; a Linux frame upgrades itself through its privileged door (dry_run=true only reports what it "
            "would do). Requires confirm=true."
        ),
        properties={"confirm": confirmed("changes what a physical frame runs"), "frame_id": FRAME_ID, "dry_run": {"type": "boolean"}},
        required=["confirm", "frame_id"],
        handler=frame_firmware_update,
    ))


async def _json(api, method: str, path: str, project_id: int | None, **kwargs: Any):
    return text(await api.json(method, path, project_id=project_id, **kwargs))
