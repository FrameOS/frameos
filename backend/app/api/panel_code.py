"""`POST /api/frames/{id}/panel/code`: the code editor on the frame's own screen
asks its backend (docs/code-editor.md). The Code editor scene reads a scene's
code on the device and changes it there; through its host
(`frameos.code`) it asks this backend for what only a control plane has:

- `{"action": "ask", "prompt", "scene"?}`: the scene AI, as the voice chat's
  `create_scene` / `change_scene` sub-turn runs it (voice_scene_builder.py,
  asked `typed`): the editor and catalog tools alone, never the MCP tools (a
  frame's key is not the owner's), the scene rendered in the frame's memory
  before it goes back. Nothing is saved: the draft is the device's.
- `{"action": "save", "scene", "show"?}`: the scene on the frame's saved list
  (one of its id replaced, its default mark, button map, layout and origin
  kept; else added), and the list sent as "Install & activate" sends it.

The frame's bearer is its `server_api_key`, as on `/panel/scenes`; a Pi posts
to `/api/panel/code`. What a frame may do is narrower than what its owner may:
a save never widens what the scene may do (the permissions and settings its
apps ask for must be ones the saved scene of that id asked for; a new scene
asks for no red permission and no settings key), nothing while the settings on
the frame's screen are off, and asks are rate limited (each is a paid model
turn).

The cloud's twin is cloud/apps/auth-web/src/lib/panel-code.ts."""
from __future__ import annotations

import json
import re
from http import HTTPStatus
from typing import Any

from arq import ArqRedis as Redis
from fastapi import Depends, Header, Path, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.panel_scenes import PANEL_ACTIONS_PER_15_MIN, _active_scene, _frame_from_bearer, _refused, _save, _show
from app.database import get_db
from app.models.frame import Frame
from app.models.log import new_log
from app.redis import get_redis
from app.utils.rate_limit import hit_rate_limit
from app.utils.scene_layouts import scene_layout_problem
from . import api_public

__all__ = ["api_frame_panel_code", "api_panel_code", "declared_grants", "grants_widened_by"]

MAX_BODY_BYTES = 1024 * 1024
MAX_PROMPT_CHARS = 2000
MAX_SCENE_ID_CHARS = 128
ASKS_PER_HOUR = 20
# The permissions that reach past the frame's own data (frontend
# utils/sceneAccess.ts sceneAccessFlagIsRisky): a new scene saved from the
# frame may ask for none of them.
RED_PERMISSIONS = ("shell", "files", "assets-write", "frame", "code")
# The calls a JavaScript app's code makes that the SPA's save stamps into its
# config.json `permissions` (frontend utils/sceneAccess.ts detectPermissions):
# counted whatever the list says, since the owner's next save of the scene
# would add them. `openAssetStream` counts as a write unless its mode is a
# literal "r".
_CODE_CALLS = (
    (re.compile(r"\bframeos\s*\.\s*frame\s*\("), "frame"),
    (re.compile(r"\bframeos\s*\.\s*code\s*\("), "code"),
    (re.compile(r"\b(writeAsset|appendAsset|deleteAsset|makeAssetFolder)\b"), "assets-write"),
    (re.compile(r"\b(listAssets|assetExists|assetSize|readAsset|loadAssetImage)\b"), "assets"),
)
_STREAM_CALL = re.compile(r"\bopenAssetStream\s*\(([^)]*)\)")
_READ_STREAM = re.compile(r"^[^,]*,\s*([\"'`])r\1\s*(,|$)")
# What the saved copy of a scene keeps when the frame sends it back.
KEPT_KEYS = ("default", "eventMap", "layout", "origin")


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str) and item] if isinstance(value, list) else []


def _code_permissions(sources: Any) -> set[str]:
    found: set[str] = set()
    for name, text in _object(sources).items():
        if not isinstance(text, str) or name == "config.json":
            continue
        for pattern, permission in _CODE_CALLS:
            if pattern.search(text):
                found.add(permission)
        for call in _STREAM_CALL.finditer(text):
            found.add("assets" if _READ_STREAM.match(call.group(1).strip()) or "," not in call.group(1) else "assets-write")
    return found


def _config_of(sources: Any) -> dict[str, Any]:
    config = _object(sources).get("config.json")
    if isinstance(config, str):
        try:
            return _object(json.loads(config))
        except ValueError:
            return {}
    return _object(config)


def declared_grants(scene: Any) -> tuple[set[str], set[str]]:
    """The permissions and settings keys a scene asks for: every app's
    config.json (the scene's apps and an app node's inline sources) and the
    built-in apps its nodes run. The frame gives an app exactly its list, so
    the list is what counts (cloud lib/panel-code-grants.ts)."""
    from app.models.apps import get_app_configs

    permissions: set[str] = set()
    settings: set[str] = set()
    scene = _object(scene)
    all_sources = [_object(app).get("sources") for app in _object(scene.get("apps")).values()]
    configs = [_config_of(sources) for sources in all_sources]
    builtins: dict[str, dict] | None = None
    for node in scene.get("nodes") if isinstance(scene.get("nodes"), list) else []:
        node = _object(node)
        if node.get("type") != "app":
            continue
        data = _object(node.get("data"))
        if isinstance(data.get("sources"), dict):
            all_sources.append(data["sources"])
            configs.append(_config_of(data["sources"]))
            continue
        keyword = data.get("keyword")
        if isinstance(keyword, str) and keyword not in _object(scene.get("apps")):
            if builtins is None:
                builtins = get_app_configs()
            # Older scenes name a built-in app without its folder.
            config = builtins.get(keyword) or next(
                (value for key, value in builtins.items() if key.endswith("/" + keyword)), None
            )
            if config:
                configs.append(config)
    for sources in all_sources:
        permissions.update(_code_permissions(sources))
    for config in configs:
        permissions.update(_strings(config.get("permissions")))
        settings.update(_strings(config.get("settings")))
    return permissions, settings


def grants_widened_by(before: tuple[set[str], set[str]] | None, after: tuple[set[str], set[str]]) -> list[str]:
    """What `after` asks for beyond `before` (the saved scene of that id; None
    for a new scene): permissions by name, settings keys as `key:<namespace>`
    (the SPA's access flags). Empty: the save widens nothing."""
    permissions, settings = after
    if before is None:
        widened = sorted(p for p in permissions if p in RED_PERMISSIONS)
        return [*widened, *(f"key:{key}" for key in sorted(settings))]
    held_permissions, held_settings = before

    def held(permission: str) -> bool:
        # `files` reads everything `assets` does.
        return permission in held_permissions or (permission == "assets" and "files" in held_permissions)

    return [
        *sorted(p for p in permissions if not held(p)),
        *(f"key:{key}" for key in sorted(settings - held_settings)),
    ]


@api_public.post("/panel/code")
async def api_panel_code(
    request: Request,
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """The same for a frame that does not know its id here (a Pi)."""
    return await _panel_code(request, None, authorization, db, redis)


@api_public.post("/frames/{id:int}/panel/code")
async def api_frame_panel_code(
    request: Request,
    id: int = Path(..., ge=1),
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    return await _panel_code(request, id, authorization, db, redis)


async def _panel_code(request: Request, id: int | None, authorization: str | None, db: Session, redis: Redis):
    frame = _frame_from_bearer(db, id, authorization)
    if frame.frame_settings_on_screen is False:
        return _refused("panel_locked", HTTPStatus.FORBIDDEN)
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return _refused("too_large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = None
    if not isinstance(body, dict) or body.get("action") not in ("ask", "save"):
        return _refused("invalid_action", HTTPStatus.BAD_REQUEST)
    if body["action"] == "ask":
        return await _ask(body, frame, db, redis)
    return await _save_scene(body, frame, db, redis)


def scene_refusal(scene: Any) -> str | None:
    """What no host saves, plane or not (docs/code-editor.md)."""
    if not isinstance(scene, dict):
        return "invalid_scene"
    scene_id = scene.get("id")
    if not isinstance(scene_id, str) or not scene_id or len(scene_id) > MAX_SCENE_ID_CHARS:
        return "invalid_scene"
    if scene_id.startswith("system/"):
        return "invalid_scene"
    if _object(scene.get("settings")).get("execution") not in (None, "interpreted"):
        return "scene_requires_compilation"
    if _object(scene.get("settings")).get("isLayout") and scene_layout_problem(scene):
        return "invalid_layout"
    return None


async def _save_scene(body: dict[str, Any], frame: Frame, db: Session, redis: Redis):
    if await hit_rate_limit(
        redis, "panel-scenes", str(frame.id), limit=PANEL_ACTIONS_PER_15_MIN, window_seconds=15 * 60
    ):
        return _refused("rate_limited", HTTPStatus.TOO_MANY_REQUESTS)
    scene = body.get("scene")
    refusal = scene_refusal(scene)
    if refusal:
        return _refused(refusal, HTTPStatus.BAD_REQUEST)
    assert isinstance(scene, dict)
    scene = {key: value for key, value in scene.items() if key not in KEPT_KEYS}
    saved = [entry for entry in (frame.scenes or []) if isinstance(entry, dict)]
    old = next((entry for entry in saved if entry.get("id") == scene["id"]), None)
    widened = grants_widened_by(declared_grants(old) if old is not None else None, declared_grants(scene))
    if widened:
        return JSONResponse(
            {"ok": False, "error": "needs_owner", "needs": widened}, status_code=HTTPStatus.FORBIDDEN
        )
    if old is not None:
        for key in KEPT_KEYS:
            if key in old:
                scene[key] = old[key]
        scenes = [scene if entry is old else entry for entry in saved]
        line = f"Changed on the frame's screen: {scene.get('name') or scene['id']}"
    else:
        scenes = [*saved, scene]
        line = f"Added on the frame's screen: {scene.get('name') or scene['id']}"
    await _save(db, redis, frame, scenes, line)
    show = body.get("show") is not False
    showing = "" if show else await _active_scene(redis, frame)
    await _show(db, redis, frame, showing or str(scene["id"]))
    return {"ok": True, "status": "queued", "scene_id": scene["id"]}


async def _ask(body: dict[str, Any], frame: Frame, db: Session, redis: Redis):
    from app.api.ai_chat import frame_context_block
    from app.api.ai_scenes import _split_state_nodes_by_app
    from app.models.settings import get_settings_dict
    from app.utils.ai_scene import CHAT_MODEL, openai_model
    from app.utils.voice_scene_builder import build_scene_by_voice

    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return _refused("empty_prompt", HTTPStatus.BAD_REQUEST)
    base = body.get("scene")
    if base is not None and (not isinstance(base, dict) or not isinstance(base.get("id"), str)):
        return _refused("invalid_scene", HTTPStatus.BAD_REQUEST)
    if base is not None:
        # What the install holds is not the scene's to change (a save keeps the plane's own).
        base = {key: value for key, value in base.items() if key not in KEPT_KEYS}
    settings = get_settings_dict(db, project_id=int(frame.project_id))
    openai_settings = settings.get("openAI") or {}
    api_key = openai_settings.get("backendApiKey")
    if not isinstance(api_key, str) or not api_key.strip():
        await new_log(db, redis, int(frame.id), "stderr", "Code editor: no OpenAI backend API key (Settings → OpenAI)")
        return _refused("ai_unavailable", HTTPStatus.SERVICE_UNAVAILABLE)
    if await hit_rate_limit(redis, "panel-code-ask", str(frame.id), limit=ASKS_PER_HOUR, window_seconds=60 * 60):
        return _refused("rate_limited", HTTPStatus.TOO_MANY_REQUESTS)
    request = prompt.strip()[:MAX_PROMPT_CHARS]
    what = f"changes {base.get('name') or base.get('id')}" if base else "builds a scene"
    await new_log(db, redis, int(frame.id), "stdinfo", f"Code editor {what}: {request[:200]}")
    built = await build_scene_by_voice(
        frame=frame,
        frame_context=frame_context_block(frame),
        request=request,
        base=base,
        name=None,
        api_key=api_key.strip(),
        model=openai_model(openai_settings, "chatModel", CHAT_MODEL),
        reasoning_effort=openai_settings.get("chatReasoningEffort") or None,
        split_state_nodes=_split_state_nodes_by_app,
        asked="typed",
    )
    if not built.get("ok") or not isinstance(built.get("scene"), dict):
        error = str(built.get("error") or "failed")
        await new_log(db, redis, int(frame.id), "stderr", f"Code editor: the scene AI failed ({error})")
        # 200 on purpose, as the voice route: the frame reads the code.
        return JSONResponse({"ok": False, "error": error, "detail": str(built.get("detail") or "")[:500]})
    scene = built["scene"]
    if base is not None:
        # A change stays the scene it changes: its save replaces it.
        scene["id"] = base["id"]
    return {"ok": True, "scene": scene, "summary": built.get("summary") or ""}
