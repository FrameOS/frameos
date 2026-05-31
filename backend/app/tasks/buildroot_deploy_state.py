from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame, update_frame
from app.tasks.buildroot_image import _buildroot_sd_image_config_payload, buildroot_sd_image_config_fingerprint
from app.tasks.frame_deploy_workflow import FRAMEOS_AVAILABLE_COMMANDS
from app.utils.versions import current_frameos_version

BOOT_REPORTED_FRAME_KEYS = ("width", "height", "color")


def _fingerprint_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _fingerprint_with_boot_reported_values_unset(frame: Frame) -> str:
    payload = _buildroot_sd_image_config_payload(frame)
    for key in BOOT_REPORTED_FRAME_KEYS:
        payload[key] = None
    return _fingerprint_payload(payload)


def _matching_ready_sd_image(frame: Frame) -> dict[str, Any] | None:
    if (frame.mode or "rpios") != "buildroot":
        return None
    if frame.last_successful_deploy_at is not None:
        return None

    buildroot = frame.buildroot if isinstance(frame.buildroot, dict) else {}
    sd_image = buildroot.get("sdImage")
    if not isinstance(sd_image, dict) or sd_image.get("status") != "ready":
        return None

    config_fingerprint = sd_image.get("configFingerprint")
    if not isinstance(config_fingerprint, str):
        return None
    if config_fingerprint not in {
        buildroot_sd_image_config_fingerprint(frame),
        _fingerprint_with_boot_reported_values_unset(frame),
    }:
        return None

    return sd_image


def buildroot_sd_image_deploy_snapshot(frame: Frame, sd_image: dict[str, Any]) -> dict[str, Any]:
    frame_dict = frame.to_dict()
    frame_dict.pop("last_successful_deploy", None)
    frame_dict.pop("last_successful_deploy_at", None)
    frame_dict["frameos_version"] = sd_image.get("frameosVersion") or current_frameos_version()
    frame_dict["frameos_commands"] = list(FRAMEOS_AVAILABLE_COMMANDS)
    return frame_dict


async def mark_buildroot_sd_image_booted(db: Session, redis: Redis, frame: Frame) -> bool:
    sd_image = _matching_ready_sd_image(frame)
    if sd_image is None:
        return False

    frame.last_successful_deploy = buildroot_sd_image_deploy_snapshot(frame, sd_image)
    frame.last_successful_deploy_at = datetime.now(timezone.utc)
    if frame.status == "uninitialized":
        frame.status = "starting"

    await update_frame(db, redis, frame)
    return True
