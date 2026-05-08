#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


VERSION_KEYS = ("frameosVersion", "frameos_version", "frameos")


def version_from_json(path: Path) -> str:
    try:
        data: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""

    if not isinstance(data, dict):
        return ""

    for key in VERSION_KEYS:
        version = data.get(key)
        if isinstance(version, str) and version:
            return version
    return ""


def main(argv: list[str]) -> int:
    for arg in argv:
        version = version_from_json(Path(arg))
        if version:
            print(version)
            return 0
    print("unknown")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
