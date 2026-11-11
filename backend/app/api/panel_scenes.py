"""`POST /api/frames/{id}/panel/scenes`: a scene change asked on the frame's
own screen (docs/scene-store-on-frame.md). The scene switcher's store page
installs and previews public store scenes, and a long press on an installed
scene updates or removes it; the frame asks this backend, which holds its
saved scenes, and never installs on its own: a scene the device added by
itself would be gone at the next deploy.

The frame's bearer is its `server_api_key`, as on `/api/log` and the
`/embedded` routes; a Pi, which does not know its id here, posts to
`/api/panel/scenes` and the key says which frame it is. Body: {"action": "install" | "preview" | "update" |
"remove" | "discard", "scene_id": "<store scene uuid>"} (for "discard", the
runtime id of the scene to go back to). Each action is what the workspace's
button does: the saved list changes and the frame gets it the way a
"Deploy scenes & settings" sends it (`api_frame_set_next_scene`, which knows
every kind of frame), showing the scene the person tapped. A preview is the
ESP32's (`queue_embedded_scene_preview`, beside the saved list); a Pi
previews on its own, as the editor's previews do there.

What a frame may do is narrower than what its owner may: public store scenes
only, fetched from this backend's store (never sent by the device); no
service key is granted (a store scene gets the groups the owner allowed in
the frame's settings, as for any store scene, docs/cloud-frames.md); nothing
while the owner has the settings on the frame's screen turned off.

The cloud's twin is cloud/apps/auth-web/src/lib/panel-scenes.ts."""
from __future__ import annotations

import json
import re
from http import HTTPStatus
from typing import Any

import httpx
from arq import ArqRedis as Redis
from fastapi import Depends, Header, HTTPException, Path, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.frame import Frame, update_frame
from app.models.log import new_log
from app.redis import get_redis
from app.utils.network import guarded_transport
from app.utils.rate_limit import hit_rate_limit
from . import api_public

__all__ = ["api_frame_panel_scenes", "api_panel_scenes"]

PANEL_ACTIONS = ("install", "update", "remove", "preview", "discard")
STORE_SCENE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_STORE_SCENES_BYTES = 4 * 1024 * 1024
MAX_RUNTIME_ID_CHARS = 128
PANEL_ACTIONS_PER_15_MIN = 60


def _frame_from_bearer(db: Session, frame_id: int | None, authorization: str | None) -> Frame:
    """The frame whose server_api_key this is (and whose id the path names,
    when it names one: a Pi does not know its id here, an ESP32 does)."""
    parts = (authorization or "").split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    frame = db.query(Frame).filter_by(server_api_key=parts[1]).first()
    if frame is None or (frame_id is not None and int(frame.id) != frame_id):
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")
    return frame


def _refused(error: str, status: int) -> JSONResponse:
    return JSONResponse({"ok": False, "error": error}, status_code=status)


def store_provider_url(db: Session) -> str | None:
    """The store this backend offers (the same choice as the repository list's
    "FrameOS Cloud store"): the linked provider, else the default one."""
    from app.models.cloud import current_cloud_backend_link
    from app.utils.cloud_link import default_cloud_provider_url

    link = current_cloud_backend_link(db)
    if link is not None and link.status == "connected" and link.provider_url:
        return str(link.provider_url).rstrip("/")
    try:
        url = default_cloud_provider_url()
    except ValueError:
        return None
    return url.rstrip("/") if url else None


async def fetch_store_scenes(provider_url: str, store_scene_id: str) -> list[dict[str, Any]]:
    """A public store scene's newest scenes.json, each scene stamped by the
    store with its `origin`. Raises HTTPException with the reason."""
    url = f"{provider_url}/api/store/scenes/{store_scene_id}/scenes.json"
    try:
        async with httpx.AsyncClient(timeout=30, transport=guarded_transport()) as client:
            async with client.stream("GET", url) as response:
                if response.status_code == HTTPStatus.NOT_FOUND:
                    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="invalid_scene")
                if response.status_code != HTTPStatus.OK:
                    raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="store_unavailable")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_STORE_SCENES_BYTES:
                        raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="scenes_payload_too_large")
    except httpx.HTTPError as error:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="store_unavailable") from error
    try:
        parsed = json.loads(bytes(body))
    except ValueError as error:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="invalid_scene_payload") from error
    scenes = [scene for scene in parsed if isinstance(scene, dict)] if isinstance(parsed, list) else []
    if not scenes or any(not isinstance(scene.get("id"), str) or not scene["id"] for scene in scenes):
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="invalid_scene_payload")
    for scene in scenes:
        if _object(scene.get("settings")).get("execution") not in (None, "interpreted"):
            raise HTTPException(status_code=HTTPStatus.CONFLICT, detail="scene_requires_compilation")
        if str(_object(scene.get("origin")).get("storeSceneId") or "").lower() != store_scene_id:
            raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="invalid_scene_payload")
        # Installed, not the frame's default: that stays the owner's.
        scene.pop("default", None)
    return scenes


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _store_scene_of(scene: Any) -> str:
    return str(_object(_object(scene).get("origin")).get("storeSceneId") or "").lower()


def _merge_field_values(installed: Any, fields: Any) -> Any:
    """The new version's fields with the values set on the installed copy, as
    the workspace's "Update" keeps them (frontend utils/sceneUpdateFields.ts):
    a field keeps its value while the new version has a field of that name
    and type."""
    if not isinstance(fields, list) or not isinstance(installed, list) or not installed:
        return fields
    by_name: dict[str, dict[str, Any]] = {}
    for field in installed:
        if isinstance(field, dict) and isinstance(field.get("name"), str) and field["name"] not in by_name:
            by_name[field["name"]] = field
    merged = []
    for field in fields:
        old = by_name.get(str(field.get("name"))) if isinstance(field, dict) else None
        if old is None or old.get("type") != field.get("type") or "value" not in old:
            merged.append(field)
        else:
            merged.append({**field, "value": old["value"]})
    return merged


def _remap_scene_ids(scene: dict[str, Any], ids: dict[str, str]) -> dict[str, Any]:
    """The new version's references to its own scenes, onto the ids the frame
    has them under: scene nodes (a split's panels), and the `sceneId` a
    dispatch or event node names (frontend utils/duplicateScenes.ts
    remapSceneIds, for the shapes a store scene uses)."""
    if not ids or not isinstance(scene.get("nodes"), list):
        return scene
    nodes = []
    for node in scene["nodes"]:
        data = node.get("data") if isinstance(node, dict) and isinstance(node.get("data"), dict) else None
        if data is None:
            nodes.append(node)
            continue
        if node.get("type") == "scene" and data.get("keyword") in ids:
            node = {**node, "data": {**data, "keyword": ids[data["keyword"]]}}
        elif node.get("type") in ("dispatch", "event") and isinstance(data.get("config"), dict):
            config = data["config"]
            if isinstance(config.get("sceneId"), str) and config["sceneId"] in ids:
                node = {**node, "data": {**data, "config": {**config, "sceneId": ids[config["sceneId"]]}}}
        nodes.append(node)
    return {**scene, "nodes": nodes}


def _carried(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """`new` in place of `old`: the frame's name for it, its default flag,
    button map, layout and the values set on it stay."""
    return {
        **old,
        "nodes": new.get("nodes"),
        "edges": new.get("edges"),
        "apps": new.get("apps"),
        "fields": _merge_field_values(old.get("fields"), new.get("fields")),
        "customEvents": new.get("customEvents"),
        "settings": new.get("settings"),
        "origin": new.get("origin"),
    }


def updated_scenes(saved: list[Any], store_scene_id: str, new_scenes: list[dict[str, Any]]) -> list[Any]:
    """The saved list with the installed copies of a store scene moved to the
    new version, as the workspace's "Update" does (sceneUpdatesLogic
    applySceneUpdate): each keeps its id, name, default flag, button map,
    layout and the field values set on it; its nodes, edges, apps, events,
    settings and origin are the new version's. A scene the new version adds
    is left out, as there."""
    installed_by_template: dict[str, str] = {}
    for scene in saved:
        if _store_scene_of(scene) == store_scene_id:
            origin = scene.get("origin") or {}
            template_id = origin.get("sceneId") if isinstance(origin.get("sceneId"), str) else scene.get("id")
            installed_by_template[str(template_id)] = str(scene.get("id"))
    remapped = {
        installed_by_template[scene["id"]]: _remap_scene_ids(scene, installed_by_template)
        for scene in new_scenes
        if scene["id"] in installed_by_template
    }
    result = []
    for scene in saved:
        new = remapped.get(str(scene.get("id"))) if isinstance(scene, dict) else None
        if new is None or _store_scene_of(scene) != store_scene_id:
            result.append(scene)
            continue
        result.append(_carried(scene, new))
    return result


async def _show(db: Session, redis: Redis, frame: Frame, scene_id: str) -> None:
    """Deploy the saved scenes and show `scene_id`: the workspace's "Install &
    activate" on every kind of frame (set_next_scene), run in the frame's
    project."""
    from app.api.frames import api_frame_set_next_scene
    from app.models.organization import Project
    from app.schemas.frames import FrameSetNextSceneRequest
    from app.tenancy import ProjectContext, reset_current_project_context, set_current_project_context

    project = db.query(Project).filter(Project.id == frame.project_id).first()
    if project is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="invalid_frame")
    token = set_current_project_context(ProjectContext(project=project, organization=project.organization, user=None))
    try:
        await api_frame_set_next_scene(
            int(frame.id), FrameSetNextSceneRequest(sceneId=scene_id, state={}, fastDeploy=True), db, redis
        )
    finally:
        reset_current_project_context(token)


async def _save(db: Session, redis: Redis, frame: Frame, scenes: list[Any], line: str) -> None:
    frame.scenes = scenes
    db.add(frame)
    db.commit()
    await update_frame(db, redis, frame)
    await new_log(db, redis, int(frame.id), "stdinfo", line)


@api_public.post("/panel/scenes")
async def api_panel_scenes(
    request: Request,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """The same for a frame that does not know its id here (a Pi): the key
    says which frame it is, as on /api/log."""
    return await _panel_scenes(request, None, authorization, db, redis)


@api_public.post("/frames/{id:int}/panel/scenes")
async def api_frame_panel_scenes(
    request: Request,
    id: int = Path(..., ge=1),
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    return await _panel_scenes(request, id, authorization, db, redis)


async def _panel_scenes(request: Request, id: int | None, authorization: str | None, db: Session, redis: Redis):
    frame = _frame_from_bearer(db, id, authorization)
    if await hit_rate_limit(
        redis, "panel-scenes", str(frame.id), limit=PANEL_ACTIONS_PER_15_MIN, window_seconds=15 * 60
    ):
        return _refused("rate_limited", HTTPStatus.TOO_MANY_REQUESTS)
    if frame.frame_settings_on_screen is False:
        return _refused("panel_locked", HTTPStatus.FORBIDDEN)
    try:
        body = json.loads((await request.body())[: 4 * 1024] or b"{}")
    except ValueError:
        body = None
    if not isinstance(body, dict) or body.get("action") not in PANEL_ACTIONS:
        return _refused("invalid_action", HTTPStatus.BAD_REQUEST)
    action = body["action"]
    given = body.get("scene_id")
    raw_id = given if isinstance(given, str) else ""
    saved = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]

    from app.utils.embedded_commands import is_queued_embedded_frame, queue_embedded_scene_preview
    from app.utils.frame_commands import discard_scene_preview

    try:
        if action == "discard":
            back_to = raw_id if 0 < len(raw_id) <= MAX_RUNTIME_ID_CHARS else ""
            if not is_queued_embedded_frame(frame):
                return _refused("preview_on_device", HTTPStatus.BAD_REQUEST)
            discard_scene_preview(db, frame)
            await new_log(db, redis, int(frame.id), "stdinfo", "Discarded the previewed scene on the frame")
            if not any(scene.get("id") == back_to for scene in saved):
                back_to = str(saved[0].get("id")) if saved else ""
            if back_to:
                await _show(db, redis, frame, back_to)
            return {"ok": True, "status": "queued"}

        store_scene_id = raw_id.lower()
        if not STORE_SCENE_ID.match(store_scene_id):
            return _refused("invalid_scene", HTTPStatus.BAD_REQUEST)
        installed = [scene for scene in saved if _store_scene_of(scene) == store_scene_id]

        if action == "remove":
            if not installed:
                return _refused("scene_not_assigned", HTTPStatus.NOT_FOUND)
            remaining = [scene for scene in saved if _store_scene_of(scene) != store_scene_id]
            if not remaining:
                return _refused("last_scene", HTTPStatus.CONFLICT)
            names = ", ".join(str(scene.get("name") or scene.get("id")) for scene in installed)
            await _save(db, redis, frame, remaining, f"Removed on the frame's screen: {names}")
            removed = {scene.get("id") for scene in installed}
            showing = await _active_scene(redis, frame)
            await _show(db, redis, frame, showing if showing and showing not in removed else str(remaining[0]["id"]))
            return {"ok": True, "status": "queued"}

        provider = store_provider_url(db)
        if not provider:
            return _refused("store_unavailable", HTTPStatus.SERVICE_UNAVAILABLE)

        if action == "install":
            if installed:
                # Already on the frame: show it, which is what was asked.
                await _show(db, redis, frame, str(installed[0]["id"]))
                return {"ok": True, "status": "queued", "already_assigned": True}
            scenes = await fetch_store_scenes(provider, store_scene_id)
            # A saved scene of the same id (an older copy from elsewhere) is
            # replaced as an update replaces it: its values, map and layout stay.
            by_id = {scene.get("id"): scene for scene in saved}
            scenes = [_carried(by_id[scene["id"]], scene) if scene["id"] in by_id else scene for scene in scenes]
            new_ids = {scene["id"] for scene in scenes}
            kept = [scene for scene in saved if scene.get("id") not in new_ids]
            await _save(db, redis, frame, [*kept, *scenes], f"Installed on the frame's screen: {scenes[0].get('name') or scenes[0]['id']}")
            await _show(db, redis, frame, str(scenes[0]["id"]))
            return {"ok": True, "status": "queued", "version": (scenes[0].get("origin") or {}).get("version")}

        if action == "update":
            if not installed:
                return _refused("scene_not_assigned", HTTPStatus.NOT_FOUND)
            scenes = await fetch_store_scenes(provider, store_scene_id)
            version = str((scenes[0].get("origin") or {}).get("version") or "")
            if all(str((scene.get("origin") or {}).get("version") or "") == version for scene in installed):
                return {"ok": True, "status": "up_to_date", "version": version}
            await _save(
                db, redis, frame, updated_scenes(saved, store_scene_id, scenes),
                f"Updated on the frame's screen: {installed[0].get('name') or installed[0].get('id')} to version {version}",
            )
            showing = await _active_scene(redis, frame)
            await _show(db, redis, frame, showing or str(installed[0]["id"]))
            return {"ok": True, "status": "queued", "version": version}

        # preview: an ESP32's, beside its saved list, shown now
        # (docs/scene-previews.md). A Pi previews on its own.
        if not is_queued_embedded_frame(frame):
            return _refused("preview_on_device", HTTPStatus.BAD_REQUEST)
        if installed:
            return _refused("already_assigned", HTTPStatus.CONFLICT)
        scenes = await fetch_store_scenes(provider, store_scene_id)
        held = {scene.get("id") for scene in saved}
        previewed = [scene for scene in scenes if scene["id"] not in held]
        if not previewed:
            # Its scenes go by the ids of scenes the frame holds: a preview
            # would push two of one id. Installing it is what replaces them.
            return _refused("already_assigned", HTTPStatus.CONFLICT)
        shown = str(previewed[0]["id"])
        outcome = await queue_embedded_scene_preview(
            db, redis, frame, [*saved, *previewed], shown, source="panel"
        )
        return {"ok": True, "status": "queued", "scene_id": shown, "command": outcome.get("status")}
    except HTTPException as error:
        detail = error.detail if isinstance(error.detail, str) else "failed"
        return _refused(detail, error.status_code)


async def _active_scene(redis: Redis, frame: Frame) -> str:
    from app.api.frames import _active_scene_id_from_cache

    try:
        return await _active_scene_id_from_cache(redis, int(frame.id)) or ""
    except Exception:
        return ""
