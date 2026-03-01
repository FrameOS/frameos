import json
from functools import lru_cache
from pathlib import Path
from typing import Any


VERSIONS_PATH = Path(__file__).resolve().parents[3] / "versions.json"


@lru_cache(maxsize=1)
def get_versions() -> dict[str, Any]:
    if not VERSIONS_PATH.exists():
        return {}

    try:
        with VERSIONS_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def current_frameos_version() -> str | None:
    version = get_versions().get("frameos")
    if not isinstance(version, str):
        return None
    return version.split("+")[0]
