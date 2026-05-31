from __future__ import annotations

import os
import time
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TIMEZONE = "UTC"


def normalize_timezone(value: object | None) -> str:
    timezone = str(value or "").strip()
    if not timezone:
        return ""
    try:
        ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        return ""
    return timezone


def guess_system_timezone() -> str:
    env_timezone = normalize_timezone(os.environ.get("TZ"))
    if env_timezone:
        return env_timezone

    timezone_file = Path("/etc/timezone")
    try:
        file_timezone = normalize_timezone(timezone_file.read_text(encoding="utf-8"))
    except OSError:
        file_timezone = ""
    if file_timezone:
        return file_timezone

    try:
        target = Path("/etc/localtime").resolve()
    except OSError:
        target = Path()
    for prefix in (
        Path("/usr/share/zoneinfo"),
        Path("/etc/zoneinfo"),
        Path("/var/db/timezone/zoneinfo"),
    ):
        try:
            relative = target.relative_to(prefix)
        except ValueError:
            continue
        symlink_timezone = normalize_timezone(relative.as_posix())
        if symlink_timezone:
            return symlink_timezone

    for candidate in time.tzname:
        guessed = normalize_timezone(candidate)
        if guessed:
            return guessed

    return DEFAULT_TIMEZONE


def frame_timezone(value: object | None, default: object | None = None) -> str:
    return normalize_timezone(value) or normalize_timezone(default) or guess_system_timezone()
