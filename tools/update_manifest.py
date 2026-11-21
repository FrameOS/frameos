#!/usr/bin/env python3
"""Edit docs/update-manifest.json (docs/auto-updates.md).

  update_manifest.py add --version 2026.11.14 [--at 2026-11-21T09:00:00Z]
      Append a release (the release workflow runs this right after the GitHub
      release and its assets exist). No rollout of its own: it follows
      defaultRollout from --at (default: now). A version already listed is
      left as it is, so a re-run of the job changes nothing.

  update_manifest.py block --version 2026.11.14 --reason "why" [--target "esp32/esp32-c3-*"]
  update_manifest.py pause --version 2026.11.14 [--at <time>]
      The edits a person makes by hand, for when it is 3 a.m.

The file keeps its layout: one release per line, so a diff shows what changed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "docs" / "update-manifest.json"
VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def _key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _time(value: str) -> str:
    text = value.strip()
    parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dump(manifest: dict) -> str:
    """JSON with every top-level key pretty, each release on one line."""
    lines = ["{"]
    keys = list(manifest.keys())
    for index, key in enumerate(keys):
        comma = "," if index < len(keys) - 1 else ""
        value = manifest[key]
        if key == "releases" and isinstance(value, list):
            lines.append('  "releases": [')
            for i, release in enumerate(value):
                tail = "," if i < len(value) - 1 else ""
                lines.append("    " + json.dumps(release, ensure_ascii=False, separators=(", ", ": ")) + tail)
            lines.append("  ]" + comma)
        elif key == "defaultRollout" and isinstance(value, list):
            lines.append('  "defaultRollout": [')
            for i, stage in enumerate(value):
                tail = "," if i < len(value) - 1 else ""
                lines.append("    " + json.dumps(stage, separators=(", ", ": ")) + tail)
            lines.append("  ]" + comma)
        else:
            text = json.dumps(value, indent=2, ensure_ascii=False).replace("\n", "\n  ")
            lines.append(f"  {json.dumps(key)}: {text}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _release(manifest: dict, version: str) -> dict:
    for release in manifest.get("releases", []):
        if isinstance(release, dict) and release.get("version") == version:
            return release
    raise SystemExit(f"{version} is not in the manifest")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add")
    add.add_argument("--version", required=True)
    add.add_argument("--at", default=None)
    block = sub.add_parser("block")
    block.add_argument("--version", required=True)
    block.add_argument("--reason", required=True)
    block.add_argument("--target", default=None)
    pause = sub.add_parser("pause")
    pause.add_argument("--version", required=True)
    pause.add_argument("--at", default=None)
    args = parser.parse_args(argv)

    version = args.version.strip().lstrip("v").split("+", 1)[0]
    if not VERSION.match(version):
        raise SystemExit(f"not a release version: {args.version!r}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    releases = manifest.setdefault("releases", [])

    if args.command == "add":
        if any(isinstance(r, dict) and r.get("version") == version for r in releases):
            print(f"{version} is already in {args.manifest}")
            return 0
        releases.append({"version": version, "at": _time(args.at) if args.at else _now()})
        releases.sort(key=lambda r: _key(r["version"]) if isinstance(r, dict) and VERSION.match(str(r.get("version", ""))) else (0,))
        print(f"added {version} to {args.manifest}")
    elif args.command == "block":
        release = _release(manifest, version)
        if args.target:
            release.setdefault("blockedTargets", {})[args.target] = args.reason
        else:
            release["blocked"] = args.reason
    elif args.command == "pause":
        _release(manifest, version)["pausedAt"] = _time(args.at) if args.at else _now()

    args.manifest.write_text(dump(manifest), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
