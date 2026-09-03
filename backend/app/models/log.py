import json
import logging
import re
from datetime import timezone, datetime
from copy import deepcopy
from ipaddress import ip_address
from typing import Any, Optional
from arq import ArqRedis as Redis

from .frame import Frame, record_successful_deploy, update_frame
from .metrics import new_metrics
from app.database import Base
from app.utils.timezone import stored_timezone
from sqlalchemy import Index, Integer, String, DateTime, ForeignKey, Text, delete, event, func, select
from sqlalchemy.orm import relationship, backref, Session, mapped_column
from app.websockets import publish_message

logger = logging.getLogger(__name__)

LOG_LIMIT_PER_FRAME = 10000
# Run the count+prune query only every N inserts per frame (per process).
# Frames stream logs continuously; counting on every insert dominated
# ingestion cost before the (frame_id, timestamp) index existed.
PRUNE_CHECK_EVERY = 100
FRAME_ACTIVITY_LOG_TYPES = ("webhook",)

_inserts_since_prune_check: dict[int, int] = {}


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware_utc(parsed)


def _is_ip_literal(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        ip_address(value)
    except ValueError:
        return False
    return True


def _follow_boot_ip_enabled(frame: Frame) -> bool:
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    return bool(embedded.get("followBootIp"))


def _accepted_boot_ip(frame: Frame, log: dict, ip: str | None) -> str | None:
    """The address a `bootup` event may move `frame_host` to, or None.

    Anyone holding a frame's server_api_key can post a bootup, and the backend
    then pushes ssh credentials and frame.json at whatever host it records, so
    the device's own claim is not enough. An embedded frame that DHCP moved is
    still followed: its claimed address must be the one the request really
    came from (`ip`, derived through the trusted-proxy rules). An explicit
    `embedded.followBootIp` opt-in trusts the claim as-is; a hostname in
    `frame_host` is never replaced.
    """
    if (frame.mode or "rpios") != "embedded":
        return None
    claimed = log.get("ip")
    if not _is_ip_literal(claimed):
        claimed = ip if _is_ip_literal(ip) else None
    if not claimed:
        return None
    current_host = frame.frame_host or ""
    if current_host and not _is_ip_literal(current_host):
        return None
    if claimed == current_host:
        return None
    if claimed == ip or _follow_boot_ip_enabled(frame):
        return claimed
    logger.warning(
        "Ignoring bootup ip %s for frame %s: request came from %s and embedded.followBootIp is off",
        claimed, frame.id, ip,
    )
    return None


def _frameos_version_from_boot(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    match = re.search(r"v?(\d+\.\d+\.\d+)", value)
    return match.group(1) if match else None


def _should_mark_embedded_boot_deployed(frame: Frame, boot_version: str | None) -> bool:
    """A boot on firmware the last recorded deploy did not know about IS the
    deploy landing: the board pulled a release over the air (the backend
    builds nothing, so the release version is the only thing that changes),
    and the deploy snapshot must say which version it now runs."""
    if (frame.mode or "rpios") != "embedded" or not boot_version:
        return False
    last_deploy = frame.last_successful_deploy if isinstance(frame.last_successful_deploy, dict) else None
    if not last_deploy:
        return False
    return _frameos_version_from_boot(last_deploy.get("frameos_version")) != boot_version


def _embedded_boot_metadata(log: dict, boot_timestamp: datetime, ip: str | None = None) -> dict[str, Any]:
    boot_ip = log.get("ip") or ip
    if isinstance(boot_ip, str):
        try:
            ip_address(boot_ip)
        except ValueError:
            boot_ip = None
    else:
        boot_ip = None

    raw_version = log.get("version")
    metadata: dict[str, Any] = {
        "at": _aware_utc(boot_timestamp).isoformat(),
        "source": log.get("source") or "embedded",
    }
    frameos_version = _frameos_version_from_boot(raw_version)
    if isinstance(raw_version, str) and raw_version:
        metadata["version"] = raw_version
    if frameos_version:
        metadata["frameosVersion"] = frameos_version
    if boot_ip:
        metadata["ip"] = boot_ip
    for key in ("width", "height", "pixelFormat", "mode", "renderMode", "panel", "wifi"):
        value = log.get(key)
        if value is not None:
            metadata[key] = value
    return metadata


def _embedded_boot_deploy_snapshot(frame: Frame, boot_metadata: dict[str, Any]) -> dict[str, Any]:
    snapshot = frame.to_dict()
    snapshot.pop("last_successful_deploy", None)
    snapshot.pop("last_successful_deploy_at", None)
    frameos_version = boot_metadata.get("frameosVersion")
    if isinstance(frameos_version, str) and frameos_version:
        snapshot["frameos_version"] = frameos_version
    return snapshot


def is_frame_activity_log(type: str, _line: str) -> bool:
    return type in FRAME_ACTIVITY_LOG_TYPES

class Log(Base):
    __tablename__ = 'log'
    __table_args__ = (
        Index('ix_log_frame_id_timestamp', 'frame_id', 'timestamp'),
    )
    id = mapped_column(Integer, primary_key=True)
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    timestamp = mapped_column(DateTime, nullable=False, default=func.current_timestamp())
    type = mapped_column(String(10), nullable=False)
    line = mapped_column(Text, nullable=False)
    ip = mapped_column(String(64), nullable=True)
    frame_id = mapped_column(Integer, ForeignKey('frame.id'), nullable=False)

    frame = relationship('Frame', backref=backref('logs', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'timestamp': self.timestamp.replace(tzinfo=timezone.utc).isoformat(),
            'type': self.type,
            'line': self.line,
            'ip': self.ip,
            'frame_id': self.frame_id
        }


@event.listens_for(Log, "before_insert")
def _set_log_project_id(_mapper, connection, target: Log):
    if target.project_id is not None or target.frame_id is None:
        return
    project_id = connection.execute(
        Frame.__table__.select().with_only_columns(Frame.__table__.c.project_id).where(Frame.__table__.c.id == target.frame_id)
    ).scalar()
    target.project_id = project_id


def maybe_prune_logs(db: Session, project_id: int, frame_id: int, inserts: int = 1) -> None:
    """Trim a frame's logs back to LOG_LIMIT_PER_FRAME, checking the count only
    every PRUNE_CHECK_EVERY inserts (and on the first insert this process sees
    for the frame). Leaves the deletes pending; the caller commits."""
    since_check = _inserts_since_prune_check.get(frame_id)
    if since_check is not None and since_check + inserts < PRUNE_CHECK_EVERY:
        _inserts_since_prune_check[frame_id] = since_check + inserts
        return
    _inserts_since_prune_check[frame_id] = 0

    frame_logs_count = db.query(Log).filter_by(project_id=project_id, frame_id=frame_id).count()
    if frame_logs_count > LOG_LIMIT_PER_FRAME + 100:
        # One bulk DELETE: loading the excess rows as ORM objects and deleting
        # them one by one held the write transaction open for the whole sweep,
        # locking out every other writer.
        oldest_ids = (
            select(Log.id)
            .where(Log.project_id == project_id, Log.frame_id == frame_id)
            .order_by(Log.timestamp)
            .limit(frame_logs_count - LOG_LIMIT_PER_FRAME)
        )
        db.execute(delete(Log).where(Log.id.in_(oldest_ids)))


async def new_log(
    db: Session,
    redis: Redis,
    frame_id: int,
    type: str,
    line: str,
    timestamp: Optional[datetime] = None,
    ip: Optional[str] = None,
) -> Log:
    timestamp = timestamp or datetime.utcnow()
    frame = db.get(Frame, frame_id)
    if frame is None:
        raise ValueError(f"Frame {frame_id} not found")

    log = Log(
        project_id=frame.project_id,
        frame_id=frame_id,
        type=type,
        line=line,
        timestamp=timestamp,
        ip=ip,
    )
    db.add(log)
    if is_frame_activity_log(type, line) and (frame.last_log_at is None or timestamp > frame.last_log_at):
        frame.last_log_at = timestamp
    # Make the pending row visible to the prune count and assign its id.
    db.flush()
    payload = {**log.to_dict(), "timestamp": log.timestamp.replace(tzinfo=timezone.utc).isoformat()}
    maybe_prune_logs(db, frame.project_id, frame_id)
    # Commit before any await. Sessions here run sync SQLAlchemy on the event
    # loop: awaiting while the flush's write transaction is open suspends this
    # task with the SQLite write lock held, and any other request that then
    # blocks on that lock freezes the loop, so the holder never resumes to
    # commit ("database is locked" storms).
    db.commit()

    await publish_message(redis, "new_log", payload)
    return log


async def process_log(
    db: Session,
    redis: Redis,
    frame: Frame,
    log: dict | list,
    ip: Optional[str] = None,
):
    if isinstance(log, list):
        timestamp = datetime.utcfromtimestamp(log[0])
        log = log[1]
    else:
        timestamp = datetime.utcnow()

    await new_log(db, redis, int(frame.id), "webhook", json.dumps(log), timestamp, ip=ip)

    assert isinstance(log, dict), f"Log must be a dict, got {type(log)}"

    event = log.get('event', 'log')

    if event in ("render:scene", "render:sceneChange", "event:setCurrentScene"):
        scene_id = log.get("sceneId") or log.get("scene") or log.get("id")
        if scene_id:
            await redis.set(f"frame:{frame.id}:active_scene", scene_id, ex=300)

    changes: dict[str, Any] = {}
    if event == 'render':
        changes['status'] = 'preparing'
    if event == 'render:device':
        changes['status'] = 'rendering'
    if event == 'render:done':
        changes['status'] = 'ready'
    marked_buildroot_sd_image_booted = False
    mark_embedded_boot_deployed = False
    embedded_boot_metadata: dict[str, Any] | None = None
    if event == 'bootup':
        from app.tasks.buildroot_deploy_state import (
            buildroot_sd_image_deploy_snapshot,
            mark_buildroot_sd_image_booted,
        )

        marked_buildroot_sd_image_booted = await mark_buildroot_sd_image_booted(db, redis, frame)
        if (frame.mode or "rpios") == "embedded":
            embedded_boot_metadata = _embedded_boot_metadata(log, timestamp, ip=ip)
            embedded = dict(frame.embedded or {})
            embedded["lastBoot"] = embedded_boot_metadata
            changes["embedded"] = embedded
            mark_embedded_boot_deployed = _should_mark_embedded_boot_deployed(
                frame, embedded_boot_metadata.get("frameosVersion")
            )
        if frame.status != 'ready':
            changes['status'] = 'ready'
        boot_ip = _accepted_boot_ip(frame, log, ip)
        if boot_ip:
            changes["frame_host"] = boot_ip
        for key in ['width', 'height', 'color']:
            # Width/height left empty means "autodetect": fill them in from the device's bootup
            # report, but never overwrite an explicitly configured resolution with a detected one.
            if key in ('width', 'height') and getattr(frame, key) is not None:
                continue
            if key in log and log[key] is not None and log[key] != getattr(frame, key):
                changes[key] = log[key]
            if 'config' in log and key in log['config'] and log['config'][key] is not None and log['config'][key] != getattr(frame, key):
                changes[key] = log['config'][key]
        if not frame.timezone:
            config = log.get("config") if isinstance(log.get("config"), dict) else {}
            boot_timezone = stored_timezone(config.get("timeZone") or log.get("timeZone"))
            if boot_timezone:
                changes["timezone"] = boot_timezone
    if len(changes) > 0:
        if frame.last_log_at is None or timestamp > frame.last_log_at:
            changes['last_log_at'] = timestamp
        for key, value in changes.items():
            setattr(frame, key, value)
        if marked_buildroot_sd_image_booted and isinstance(frame.last_successful_deploy, dict):
            record_successful_deploy(
                frame, buildroot_sd_image_deploy_snapshot(frame, frame.buildroot["sdImage"]), frame.last_successful_deploy_at
            )
        if mark_embedded_boot_deployed and embedded_boot_metadata is not None:
            record_successful_deploy(frame, _embedded_boot_deploy_snapshot(frame, embedded_boot_metadata), timestamp)
        await update_frame(db, redis, frame)

    if event == 'metrics':
        metrics_dict = deepcopy(log)
        if 'event' in metrics_dict:
            del metrics_dict['event']
        if 'timestamp' in metrics_dict:
            del metrics_dict['timestamp']
        await new_metrics(db, redis, int(frame.id), metrics_dict)
