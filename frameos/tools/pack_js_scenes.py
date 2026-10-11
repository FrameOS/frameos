#!/usr/bin/env python3
"""Pack pure JS sample scenes into their scenes.json.

A JS sample under repo/scenes/samples/<Name>/ is authored as files — a
scene.json (id, name, settings, fields) next to scene.ts and whatever it
imports — because a module is nicer to read and edit as a file than as one
JSON string. The frame, the editor and the store want the scene as JSON with
the files inlined under "sources", which is what this writes:

    python3 frameos/tools/pack_js_scenes.py          # rewrite every scenes.json
    python3 frameos/tools/pack_js_scenes.py --check  # fail when one is stale

The generated scenes.json files are committed (the asset pipeline reads
them); `--check` runs in the backend test suite so they cannot drift.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".json"}
SKIP_FILES = {"scene.json", "scenes.json", "template.json"}


def sample_dirs(root: Path) -> list[Path]:
    return sorted(p.parent for p in root.glob("*/scene.json"))


def pack(sample: Path) -> list[dict]:
    scene = json.loads((sample / "scene.json").read_text())
    sources: dict[str, str] = {}
    for path in sorted(sample.rglob("*")):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        relative = path.relative_to(sample).as_posix()
        if relative in SKIP_FILES:
            continue
        sources[relative] = path.read_text()
    if "scene.ts" not in sources and "scene.tsx" not in sources and "scene.js" not in sources:
        raise SystemExit(f"{sample}: no scene.ts next to scene.json")
    scene.setdefault("settings", {})["execution"] = "js"
    scene.setdefault("nodes", [])
    scene.setdefault("edges", [])
    scene["sources"] = sources
    return [scene]


def render(scenes: list[dict]) -> str:
    return json.dumps(scenes, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="exit 1 when a scenes.json is stale instead of writing it")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2] / "repo" / "scenes" / "samples"))
    args = parser.parse_args()
    root = Path(args.root)
    stale: list[str] = []
    for sample in sample_dirs(root):
        expected = render(pack(sample))
        target = sample / "scenes.json"
        current = target.read_text() if target.exists() else None
        if current == expected:
            continue
        if args.check:
            stale.append(str(target))
        else:
            target.write_text(expected)
            print(f"wrote {target}")
    if stale:
        print("stale scenes.json (run frameos/tools/pack_js_scenes.py):", *stale, sep="\n  ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
