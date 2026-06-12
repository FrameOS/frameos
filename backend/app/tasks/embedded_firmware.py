"""Build flashable firmware images for embedded (ESP32) frames.

Milestone M0 (see repo-root TODO.md): the firmware is a stub that blinks the
onboard LED — no FrameOS runtime yet. The pipeline mirrors the Buildroot SD
image flow: an arq task builds the image, status lives on the frame's
``embedded.firmware`` JSON, and a download endpoint serves a single binary
flashable over USB serial at offset 0x0.

Requires ESP-IDF on the machine running the worker: the ``IDF_PATH`` env var,
or a checkout at ``~/esp/esp-idf`` (see embedded/esp32/README.md).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from arq import ArqRedis as Redis
from arq.jobs import Job, JobStatus
from sqlalchemy.orm import Session

from app.models.frame import Frame, update_frame
from app.models.log import new_log as log
from app.tasks.utils import get_fresh_frame
from app.utils.token import secure_token

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_EMBEDDED_PLATFORM = "esp32-s3"
EMBEDDED_PLATFORM_ALIASES = {"", "esp32s3", "esp32-s3-devkitc-1"}
EMBEDDED_PROJECT_DIR = REPO_ROOT / "embedded" / "esp32"
EMBEDDED_IDF_TARGET = "esp32s3"
# Bump when the firmware project changes so existing "ready" images rebuild on next request
EMBEDDED_FIRMWARE_VERSION = 3
EMBEDDED_FLASH_OFFSET = "0x0"
EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS = int(
    os.environ.get("FRAMEOS_EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS", str(15 * 60))
)
ACTIVE_FIRMWARE_STATUSES = {"queued", "building"}
ACTIVE_ARQ_JOB_STATUSES = {JobStatus.deferred, JobStatus.queued, JobStatus.in_progress}

# idf.py builds are not safe to run concurrently in the same build directory
_build_lock = asyncio.Lock()


def normalize_embedded_platform(platform: str | None) -> str:
    value = (platform or "").strip()
    if value == SUPPORTED_EMBEDDED_PLATFORM or value in EMBEDDED_PLATFORM_ALIASES:
        return SUPPORTED_EMBEDDED_PLATFORM
    raise ValueError(f"Unsupported embedded platform: {value or '(empty)'}")


def embedded_artifact_dir() -> Path:
    return Path(
        os.environ.get("FRAMEOS_EMBEDDED_ARTIFACT_DIR")
        or (REPO_ROOT / "db" / "artifacts" / "embedded-firmware")
    )


def embedded_idf_path() -> Path:
    return Path(os.environ.get("IDF_PATH") or (Path.home() / "esp" / "esp-idf"))


def embedded_toolchain_available() -> bool:
    return (embedded_idf_path() / "export.sh").is_file()


def ensure_embedded_frame_defaults(frame: Frame, platform: str | None = None) -> None:
    normalized_platform = normalize_embedded_platform(platform or (frame.embedded or {}).get("platform"))

    frame.mode = "embedded"
    if not frame.frame_host:
        frame.frame_host = f"frame{frame.id}.local" if frame.id else "frame.local"

    # No SSH, no HTTPS proxy, no agent on a microcontroller
    https_proxy = dict(frame.https_proxy or {})
    https_proxy["enable"] = False
    frame.https_proxy = https_proxy
    agent = dict(frame.agent or {})
    agent["agentEnabled"] = False
    agent["agentRunCommands"] = False
    agent["deployWithAgent"] = False
    frame.agent = agent
    frame.log_to_file = None

    embedded = dict(frame.embedded or {})
    embedded["platform"] = normalized_platform
    frame.embedded = embedded


def clear_embedded_firmware(frame: Frame | Any) -> None:
    embedded = dict(getattr(frame, "embedded", None) or {})
    embedded.pop("firmware", None)
    frame.embedded = embedded


def latest_embedded_firmware(frame: Frame) -> dict[str, Any] | None:
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    firmware = embedded.get("firmware")
    if not isinstance(firmware, dict):
        return None
    if firmware.get("status") == "ready" and firmware.get("firmwareVersion") != EMBEDDED_FIRMWARE_VERSION:
        return {
            **firmware,
            "status": "stale",
            "error": "The generated firmware was built from an older firmware project version",
        }
    path = firmware.get("path")
    if firmware.get("status") == "ready" and isinstance(path, str) and not Path(path).is_file():
        return {**firmware, "status": "missing", "error": "The generated firmware file is missing"}
    return firmware


async def refresh_embedded_firmware_status(db: Session, redis: Redis, frame: Frame) -> dict[str, Any] | None:
    firmware = latest_embedded_firmware(frame)
    if not firmware or firmware.get("status") not in ACTIVE_FIRMWARE_STATUSES:
        return firmware
    if await _firmware_queue_job_active(redis, firmware):
        return firmware

    error = (
        "Firmware build stopped updating. "
        "The worker process probably exited; start the firmware build again."
    )
    recovered = {**firmware, "status": "error", "error": error, "completedAt": _utc_now()}
    await log(db, redis, int(frame.id), "stderr", f"Marking embedded firmware build as failed: {error}")
    await _set_firmware_status(db, redis, frame, recovered)
    return recovered


async def start_embedded_firmware(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    force: bool = False,
) -> tuple[bool, dict[str, Any]]:
    if not embedded_toolchain_available():
        raise ValueError(
            f"ESP-IDF toolchain not found at {embedded_idf_path()}. "
            "Set IDF_PATH or install it (see embedded/esp32/README.md)."
        )

    firmware = latest_embedded_firmware(frame)
    if firmware and firmware.get("status") == "ready" and not force:
        return False, firmware
    if firmware and firmware.get("status") in ACTIVE_FIRMWARE_STATUSES:
        if await _firmware_queue_job_active(redis, firmware):
            return False, firmware
        await log(db, redis, int(frame.id), "stderr",
                  "Recovering stale embedded firmware build state; previous worker job is no longer active")

    request_id = secure_token(12)
    queue_job_id = _queue_job_id(frame.id, request_id)
    queued_at = _utc_now()
    metadata: dict[str, Any] = {
        "status": "queued",
        "requestId": request_id,
        "queueJobId": queue_job_id,
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "queuedAt": queued_at,
        "startedAt": queued_at,
    }
    await _set_firmware_status(db, redis, frame, metadata)

    try:
        await redis.enqueue_job("embedded_firmware", id=int(frame.id), request_id=request_id, _job_id=queue_job_id)
    except Exception as exc:
        await _set_firmware_status(db, redis, frame, {
            **metadata,
            "status": "error",
            "error": f"Failed to enqueue embedded firmware build: {exc}",
            "completedAt": _utc_now(),
        })
        raise

    return True, latest_embedded_firmware(frame) or metadata


async def embedded_firmware_task(ctx: dict[str, Any], id: int, request_id: str | None = None):
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    frame: Optional[Frame] = get_fresh_frame(db, id)
    if frame is None:
        await log(db, redis, id, "stderr", "Frame not found")
        raise Exception("Frame not found")

    try:
        ensure_embedded_frame_defaults(frame)
        if request_id and not _firmware_request_matches(frame, request_id):
            await log(db, redis, id, "stderr", "Ignoring stale embedded firmware worker job")
            return
        await _build_firmware(db, redis, frame, request_id)
    except Exception as exc:
        frame = get_fresh_frame(db, id) or frame
        if not request_id or _firmware_request_matches(frame, request_id):
            current = latest_embedded_firmware(frame) or {}
            await _set_firmware_status(db, redis, frame, {
                **_preserved_queue_metadata(current),
                "status": "error",
                "platform": SUPPORTED_EMBEDDED_PLATFORM,
                "error": str(exc),
                "completedAt": _utc_now(),
            })
        await log(db, redis, id, "stderr", f"Embedded firmware build failed: {exc}")
        raise


async def _build_firmware(db: Session, redis: Redis, frame: Frame, request_id: str | None) -> None:
    if not EMBEDDED_PROJECT_DIR.is_dir():
        raise ValueError(f"Embedded firmware project not found at {EMBEDDED_PROJECT_DIR}")
    idf_path = embedded_idf_path()
    if not (idf_path / "export.sh").is_file():
        raise ValueError(f"ESP-IDF toolchain not found at {idf_path}")

    current = latest_embedded_firmware(frame) or {}
    started_at = _utc_now()
    await _set_firmware_status(db, redis, frame, {
        **_preserved_queue_metadata(current),
        "status": "building",
        "requestId": request_id or current.get("requestId"),
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "startedAt": started_at,
        "lastHeartbeatAt": started_at,
    })
    await log(db, redis, int(frame.id), "stdout",
              f"Building ESP32-S3 firmware with ESP-IDF at {idf_path}")

    build_dir = EMBEDDED_PROJECT_DIR / "build"
    # export.sh refuses to run inside a foreign Python venv; scrub venv vars and
    # let it activate the ESP-IDF Python environment itself.
    env = {k: v for k, v in os.environ.items() if k not in {"VIRTUAL_ENV", "IDF_PYTHON_ENV_PATH"}}
    env["PATH"] = os.pathsep.join(
        p for p in env.get("PATH", "").split(os.pathsep) if "/.venv/" not in p and not p.endswith("/.venv/bin")
    )
    env["IDF_PATH"] = str(idf_path)
    env["IDF_TARGET"] = EMBEDDED_IDF_TARGET
    command = f'source "$IDF_PATH/export.sh" >/dev/null 2>&1 && idf.py build merge-bin'

    async with _build_lock:
        process = await asyncio.create_subprocess_exec(
            "bash", "-c", command,
            cwd=str(EMBEDDED_PROJECT_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        output_tail: list[str] = []
        assert process.stdout is not None
        last_heartbeat = datetime.now(timezone.utc)
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                output_tail.append(text)
                del output_tail[:-50]
            now = datetime.now(timezone.utc)
            if (now - last_heartbeat).total_seconds() >= 15:
                last_heartbeat = now
                frame = get_fresh_frame(db, int(frame.id)) or frame
                current = latest_embedded_firmware(frame) or {}
                if current.get("status") == "building":
                    await _set_firmware_status(db, redis, frame, {**current, "lastHeartbeatAt": _utc_now()})
        returncode = await process.wait()

    if returncode != 0:
        tail = "\n".join(output_tail[-20:])
        raise ValueError(f"idf.py build failed with exit code {returncode}:\n{tail}")

    merged_bin = build_dir / "merged-binary.bin"
    if not merged_bin.is_file():
        raise ValueError(f"Build succeeded but {merged_bin} was not produced")

    artifact_dir = embedded_artifact_dir()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    filename = f"frameos-{SUPPORTED_EMBEDDED_PLATFORM}-frame{frame.id}.bin"
    artifact_path = artifact_dir / filename
    shutil.copyfile(merged_bin, artifact_path)

    frame = get_fresh_frame(db, int(frame.id)) or frame
    current = latest_embedded_firmware(frame) or {}
    await _set_firmware_status(db, redis, frame, {
        **_preserved_queue_metadata(current),
        "status": "ready",
        "requestId": request_id or current.get("requestId"),
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "firmwareVersion": EMBEDDED_FIRMWARE_VERSION,
        "filename": filename,
        "path": str(artifact_path),
        "size": artifact_path.stat().st_size,
        "sha256": _sha256(artifact_path),
        "flashOffset": EMBEDDED_FLASH_OFFSET,
        "startedAt": current.get("startedAt") or started_at,
        "completedAt": _utc_now(),
        "downloadUrl": f"/api/frames/{frame.id}/embedded/firmware/download",
    })
    await log(db, redis, int(frame.id), "stdout",
              f"ESP32-S3 firmware ready: {filename} ({artifact_path.stat().st_size} bytes)")


async def _firmware_queue_job_active(redis: Redis, firmware: dict[str, Any]) -> bool:
    job_id = firmware.get("queueJobId")
    if not isinstance(job_id, str) or not job_id:
        return False
    try:
        status = await Job(job_id, redis).status()
        return status in ACTIVE_ARQ_JOB_STATUSES and not _firmware_inactive(firmware)
    except Exception:
        return not _firmware_inactive(firmware)


def _firmware_inactive(firmware: dict[str, Any]) -> bool:
    timestamp = _parse_utc(firmware.get("lastHeartbeatAt") or firmware.get("startedAt") or firmware.get("queuedAt"))
    if timestamp is None:
        return True
    return (datetime.now(timezone.utc) - timestamp).total_seconds() > EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS


def _parse_utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _queue_job_id(frame_id: int, request_id: str) -> str:
    return f"embedded_firmware:{frame_id}:{request_id}"


def _firmware_request_matches(frame: Frame, request_id: str) -> bool:
    firmware = latest_embedded_firmware(frame) or {}
    return firmware.get("requestId") == request_id


def _preserved_queue_metadata(firmware: dict[str, Any]) -> dict[str, Any]:
    return {
        key: firmware[key]
        for key in ("requestId", "queueJobId", "queuedAt")
        if isinstance(firmware.get(key), str) and firmware.get(key)
    }


async def _set_firmware_status(db: Session, redis: Redis, frame: Frame, firmware: dict[str, Any]) -> None:
    embedded = dict(frame.embedded or {})
    embedded["platform"] = normalize_embedded_platform(embedded.get("platform"))
    embedded["firmware"] = firmware
    frame.embedded = embedded
    await update_frame(db, redis, frame)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
