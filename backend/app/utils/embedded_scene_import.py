"""An adopted ESP32's own scenes, read into the backend.

A board adopted by its code (`_adopt_embedded_frame` in app/api/frame_sync.py)
holds scenes of its own, and the row the backend made for it holds none. A
board replaces its whole store with any set a pull or a push gives it, so
until its scenes are read the backend must never give it one: the row
carries `embedded.sceneImport: "pending"` from before the board is told this
backend until the import lands, and while it does the board's scene pull
(`/embedded/scenes`) answers 503, which the board logs and keeps what it
holds (fos_scenes.c, `http-error`). Every way a backend sends an adopted
board scenes is that pull (a deploy, a preview, "Push & activate": its
firmware pulls commands).

The adoption reads them as soon as the board answers again on its new
credentials; if it does not answer in time, the board's next check-in
(`/embedded/commands`) or refused pull starts the import again, at most once
a minute. It reads the board's list (`GET /api/frames/<id>/scenes`) and each
scene (`GET /api/frames/<id>/scenes/<sceneId>`) with the server API key the
board was given, adds every scene the row does not hold by id (one saved here
meanwhile stays), records them as what the board holds in the deploy
baseline, so the workspace shows nothing pending for them, and drops the
marker. A Pi's adoption imports its scenes from its frame.json the same way
(`adopt_standalone_frame`).
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import quote

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, update_frame
from app.models.log import new_log
from app.utils.legacy_app_migration import migrate_legacy_apps_in_scenes
from app.utils.retired_apps import retire_apps_in_scenes
from app.utils.scene_execution import normalize_scenes_execution
from app.utils.server_render import SERVER_RENDERED_BOARD_SCENE

logger = logging.getLogger(__name__)

FrameFetch = Callable[..., Awaitable[tuple[int, bytes, dict[str, Any]]]]

# On `frame.embedded`, beside what the board reports (lastBoot, storage): the
# backend's own, kept across a settings save (app/api/frames.py).
SCENE_IMPORT_KEY = "sceneImport"
SCENE_IMPORT_PENDING = "pending"

# One import at a time per frame, at most one a minute, in every process (the
# Home Assistant add-on runs two uvicorns): a Redis claim.
IMPORT_CLAIM_KEY = "frame:{}:embedded_scene_import"
IMPORT_RETRY_SECONDS = 60

_background_imports: set[asyncio.Task[Any]] = set()


class SceneImportError(Exception):
    """The board's scenes could not be read; the row is as it was."""


class SceneListMissing(SceneImportError):
    """The board has no scene list to read (HTTP 404: a firmware without the
    route). No retry would change that, so the import ends with no scenes."""


def scene_import_pending(frame: Any) -> bool:
    embedded = getattr(frame, "embedded", None)
    return isinstance(embedded, dict) and embedded.get(SCENE_IMPORT_KEY) == SCENE_IMPORT_PENDING


def _json(body: bytes, what: str) -> Any:
    try:
        return json.loads(body.decode("utf-8", errors="replace") or "null")
    except ValueError as exc:
        raise SceneImportError(f"the frame's {what} is not JSON") from exc


async def read_board_scene(
    frame: Frame, redis: Redis, fetch: FrameFetch, scene_id: str, *, attempts: int | None = None
) -> dict[str, Any]:
    """One scene the board holds, whole (embedded/esp32/README.md "One scene
    at a time"). Raises SceneImportError."""
    path = f"/api/frames/{int(frame.id)}/scenes/{quote(scene_id, safe='')}"
    status, body, _headers = await fetch(frame, redis, path=path, attempts=attempts)
    if status != 200:
        raise SceneImportError(f"the frame answered HTTP {status} for its scene {scene_id!r}")
    scene = _json(body, f"scene {scene_id!r}")
    if not isinstance(scene, dict) or scene.get("id") != scene_id:
        raise SceneImportError(f"the frame's scene {scene_id!r} is not that scene")
    return scene


def _unreadable(error: SceneImportError) -> bool:
    """A scene the board listed and will never serve (gone since, a slot it
    cannot read): skipped, so one bad slot does not hold every scene pull
    back for good. A board that is away (no answer, a 5xx) is tried again."""
    text = str(error)
    return "HTTP 4" in text or "not JSON" in text or "is not that scene" in text


async def read_board_scenes(
    frame: Frame, redis: Redis, fetch: FrameFetch, *, attempts: int | None = None
) -> list[dict[str, Any]]:
    """Every scene the board holds, as it holds it. Raises SceneImportError."""
    base = f"/api/frames/{int(frame.id)}/scenes"
    status, body, _headers = await fetch(frame, redis, path=base, attempts=attempts)
    if status == 404:
        raise SceneListMissing("the frame's firmware does not list its scenes")
    if status != 200:
        raise SceneImportError(f"the frame answered HTTP {status} for its scene list")
    listing = _json(body, "scene list")
    if not isinstance(listing, dict):
        raise SceneImportError("the frame's scene list is not an object")
    entries = listing.get("scenes")
    if not isinstance(entries, list):
        # A store that is not split into one file a scene lists none, and
        # its storage still counts them: read it again later, never "none".
        storage = listing.get("storage")
        if isinstance(storage, dict) and storage.get("sceneCount"):
            raise SceneImportError("the frame did not list its scenes")
        entries = []
    scenes: list[dict[str, Any]] = []
    for entry in entries:
        scene_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(scene_id, str) or not scene_id or scene_id == SERVER_RENDERED_BOARD_SCENE["id"]:
            continue
        try:
            scenes.append(await read_board_scene(frame, redis, fetch, scene_id, attempts=attempts))
        except SceneImportError as error:
            if not _unreadable(error):
                raise
            logger.warning("embedded scene import for frame %s: skipped: %s", frame.id, error)
    return scenes


async def import_embedded_frame_scenes(
    db: Session, redis: Redis, frame: Frame, fetch: FrameFetch, *, attempts: int | None = None
) -> int:
    """Read the board's scenes into the row and clear the marker; returns how
    many were added. Raises SceneImportError (or the fetch's HTTPException)
    and then changes nothing."""
    try:
        scenes = await read_board_scenes(frame, redis, fetch, attempts=attempts)
    except SceneListMissing:
        # Nothing to read, ever: the import ends here, and the next deploy
        # gives the board the backend's scenes, as adoption did before it
        # read them. Holding the pull back would hold every deploy back.
        scenes = []
    # As a Pi's adoption takes its scenes: they may predate a retired app.
    migrate_legacy_apps_in_scenes(scenes)
    retire_apps_in_scenes(scenes)
    normalize_scenes_execution(scenes)

    # The row as it is now: the board's check-ins wrote to it while it was read.
    db.refresh(frame)
    if not scene_import_pending(frame):
        return 0
    held = [scene for scene in (frame.scenes or []) if isinstance(scene, dict)]
    held_ids = {scene.get("id") for scene in held}
    added = [scene for scene in scenes if scene["id"] not in held_ids]
    frame.scenes = held + copy.deepcopy(added)
    frame.embedded = {key: value for key, value in (frame.embedded or {}).items() if key != SCENE_IMPORT_KEY}
    baseline = frame.last_successful_deploy
    if isinstance(baseline, dict):
        # What the board holds is what was deployed to it.
        baseline = {**baseline, "scenes": scenes}
        if isinstance(baseline.get("embedded"), dict):
            baseline["embedded"] = {
                key: value for key, value in baseline["embedded"].items() if key != SCENE_IMPORT_KEY
            }
        frame.last_successful_deploy = baseline
    await update_frame(db, redis, frame)
    await new_log(
        db, redis, int(frame.id), "stdinfo",
        f"Read {len(scenes)} scene{'' if len(scenes) == 1 else 's'} from the frame"
        + (f", {len(added)} new here" if len(added) != len(scenes) else ""),
    )
    return len(added)


async def claim_scene_import(redis: Redis, frame_id: int, seconds: int = IMPORT_RETRY_SECONDS) -> bool:
    try:
        return bool(await redis.set(IMPORT_CLAIM_KEY.format(frame_id), "1", ex=seconds, nx=True))
    except Exception:  # noqa: BLE001 - no Redis, no import now: the marker keeps the scenes safe
        return False


async def release_scene_import(redis: Redis, frame_id: int) -> None:
    try:
        await redis.delete(IMPORT_CLAIM_KEY.format(frame_id))
    except Exception:  # noqa: BLE001
        pass


async def _import_in_background(frame_id: int, redis: Redis, fetch: FrameFetch | None) -> None:
    from app.database import SessionLocal
    from app.utils.frame_http import _fetch_frame_http_bytes

    db = SessionLocal()
    try:
        frame = db.get(Frame, frame_id)
        if frame is not None and scene_import_pending(frame):
            await import_embedded_frame_scenes(db, redis, frame, fetch or _fetch_frame_http_bytes)
    except Exception as exc:  # noqa: BLE001 - the next check-in tries again; the marker keeps the scenes safe
        logger.info("embedded scene import for frame %s: %s", frame_id, exc)
    finally:
        db.close()


async def start_scene_import(redis: Redis, frame: Frame, fetch: FrameFetch | None = None) -> asyncio.Task[Any] | None:
    """Read a frame's own scenes in the background if they are still to be
    read and no import has started in the last minute. Never waits for it."""
    if not scene_import_pending(frame) or not await claim_scene_import(redis, int(frame.id)):
        return None
    task = asyncio.create_task(_import_in_background(int(frame.id), redis, fetch))
    _background_imports.add(task)
    task.add_done_callback(_background_imports.discard)
    return task
