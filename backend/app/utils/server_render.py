"""A thin client's picture, drawn on the backend before the frame wakes.

docs/server-rendering.md "Deep sleep: the picture is drawn before the wake".
A frame rendered on the server (an ESP32-C3, or an ESP32-S3 with
``device_config.renderMode`` remote) announces its sleep with a ``sleep`` log
line; the backend then draws the frame's next picture ``lead`` seconds before
the wake, with the scene's clock set to the wake's render time, and keeps it
here. The pull at the wake takes it instead of rendering, when nothing changed
in between: same scene, scenes, settings and panel (the fingerprint), no
scene state written and no event held since (the revision), and within
PRERENDER_MAX_SKEW_SECONDS of the time it was drawn for.

The revision is a per-frame counter every write to a thin client's scene
state and every held event moves (``bump_render_revision``); a picture drawn
at one revision says nothing about the scene at the next.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.models.frame import Frame

logger = logging.getLogger(__name__)

# A kept picture is good this far either side of the time it was drawn for.
PRERENDER_MAX_SKEW_SECONDS = 120
# How long before the wake the drawing starts: twice the frame's last render
# on the backend plus PRERENDER_LEAD_EXTRA_SECONDS, within these bounds.
PRERENDER_LEAD_MIN_SECONDS = 20
PRERENDER_LEAD_MAX_SECONDS = 90
PRERENDER_LEAD_EXTRA_SECONDS = 10
# A kept picture outlives the time it was drawn for by this much, then Redis
# lets it go: a frame that never came back leaves nothing behind.
PRERENDER_KEEP_AFTER_SECONDS = 300
PRERENDER_JOB = "prerender_thin_client"


def _revision_key(frame_id: int) -> str:
    return f"frame:{frame_id}:render_revision"


def _render_ms_key(frame_id: int) -> str:
    return f"frame:{frame_id}:server_render_ms"


def _prerender_meta_key(frame_id: int) -> str:
    return f"frame:{frame_id}:prerender"


def _prerender_body_key(frame_id: int) -> str:
    return f"frame:{frame_id}:prerender:body"


def fosb_etag(body: bytes) -> str:
    """The pull's ETag: the first 32 hex digits of the body's sha256, quoted."""
    return '"' + hashlib.sha256(body).hexdigest()[:32] + '"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Whether an If-None-Match header names ``etag`` (weak or strong, in a
    list, or ``*``)."""
    if not if_none_match:
        return False
    wanted = etag.strip().removeprefix("W/")
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        if candidate.removeprefix("W/") == wanted:
            return True
    return False


def render_fingerprint(
    scenes: list | None,
    settings: dict | None,
    scene_id: str | None,
    width: int,
    height: int,
    pixel_format: int,
    rotate: int,
) -> str:
    """What a picture was drawn from besides the scene state: the scene list,
    the service settings, the scene shown and the panel."""
    material = json.dumps(
        [scenes or [], settings or {}, scene_id or "", int(width), int(height), int(pixel_format), int(rotate) % 360],
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def bump_render_revision(redis, frame_id: int) -> None:
    """A thin client's scene state was written or an event was held: a
    picture drawn before now is no longer the one the frame should show."""
    if redis is None:
        return
    try:
        await redis.incr(_revision_key(int(frame_id)))
    except Exception:
        # A counter that could not move must not cost a write its success;
        # the worst it does is let one kept picture through.
        logger.debug("render revision bump failed for frame %s", frame_id, exc_info=True)


async def render_revision(redis, frame_id: int) -> int:
    if redis is None:
        return 0
    try:
        raw = await redis.get(_revision_key(int(frame_id)))
    except Exception:
        return 0
    try:
        return int(raw) if raw is not None else 0
    except (TypeError, ValueError):
        return 0


async def remember_render_ms(redis, frame_id: int, ms: int) -> None:
    """How long the frame's last render on the backend took, for the lead."""
    if redis is None:
        return
    try:
        await redis.set(_render_ms_key(int(frame_id)), max(0, int(ms)))
    except Exception:
        pass


async def last_render_ms(redis, frame_id: int) -> int | None:
    if redis is None:
        return None
    try:
        raw = await redis.get(_render_ms_key(int(frame_id)))
        return int(raw) if raw is not None else None
    except Exception:
        return None


def prerender_lead_seconds(last_ms: int | None) -> int:
    """Twice the frame's last render plus ten seconds, between 20 and 90."""
    seconds = 2 * (last_ms or 0) / 1000 + PRERENDER_LEAD_EXTRA_SECONDS
    return int(min(PRERENDER_LEAD_MAX_SECONDS, max(PRERENDER_LEAD_MIN_SECONDS, seconds)))


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def prerender_as_of(frame: Frame) -> datetime | None:
    """When the frame's next picture is for (naive UTC): the render time its
    sleep announced, else its wake. None while it is not asleep."""
    if frame.next_wake_at is None:
        return None
    return _naive_utc(frame.next_render_at) or _naive_utc(frame.next_wake_at)


def epoch_ms(value: datetime) -> int:
    naive = _naive_utc(value)
    assert naive is not None
    return int(naive.replace(tzinfo=timezone.utc).timestamp() * 1000)


async def schedule_prerender(redis, frame: Frame, now: datetime | None = None) -> bool:
    """Queue the drawing of a sleeping thin client's next picture, to run
    ``lead`` seconds before the wake. False when there is nothing to draw
    for (not a thin client, not asleep) or the queue would not take it."""
    from app.tasks.embedded_firmware import is_thin_client_frame

    if redis is None or not is_thin_client_frame(frame):
        return False
    as_of = prerender_as_of(frame)
    if as_of is None:
        return False
    now = _naive_utc(now) or datetime.utcnow()
    lead = prerender_lead_seconds(await last_render_ms(redis, int(frame.id)))
    start = as_of - timedelta(seconds=lead)
    as_of_ms = epoch_ms(as_of)
    kwargs: dict[str, Any] = {"id": int(frame.id), "as_of_ms": as_of_ms, "_job_id": f"prerender:{frame.id}:{as_of_ms}"}
    if start > now:
        kwargs["_defer_until"] = start.replace(tzinfo=timezone.utc)
    try:
        job = await redis.enqueue_job(PRERENDER_JOB, **kwargs)
    except Exception:
        logger.warning("could not queue the pre-render of frame %s", frame.id, exc_info=True)
        return False
    return job is not None


async def keep_prerender(redis, frame_id: int, record: dict, body: bytes, as_of_ms: int) -> None:
    """Keep a picture drawn ahead of the wake, with what it was drawn from."""
    ttl = max(60, int((as_of_ms / 1000) - datetime.now(timezone.utc).timestamp()) + PRERENDER_KEEP_AFTER_SECONDS)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.set(_prerender_meta_key(int(frame_id)), json.dumps(record, separators=(",", ":")), ex=ttl)
        pipe.set(_prerender_body_key(int(frame_id)), body, ex=ttl)
        await pipe.execute()


async def take_prerender(redis, frame_id: int) -> tuple[dict, bytes] | None:
    """The kept picture and its record, gone from the store: it is used once
    (or found stale) by the pull that takes it."""
    if redis is None:
        return None
    try:
        async with redis.pipeline(transaction=True) as pipe:
            pipe.get(_prerender_meta_key(int(frame_id)))
            pipe.get(_prerender_body_key(int(frame_id)))
            pipe.delete(_prerender_meta_key(int(frame_id)), _prerender_body_key(int(frame_id)))
            raw_meta, body, _deleted = await pipe.execute()
    except Exception:
        return None
    if not raw_meta or not body:
        return None
    try:
        record = json.loads(raw_meta)
    except (TypeError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    return record, bytes(body)


def prerender_usable(record: dict, *, fingerprint: str, revision: int, now_ms: int) -> bool:
    """Whether a kept picture is the one the pull would draw now."""
    as_of = record.get("asOfMs")
    if not isinstance(as_of, int) or isinstance(as_of, bool):
        return False
    if abs(now_ms - as_of) > PRERENDER_MAX_SKEW_SECONDS * 1000:
        return False
    return record.get("fingerprint") == fingerprint and record.get("revision") == revision
