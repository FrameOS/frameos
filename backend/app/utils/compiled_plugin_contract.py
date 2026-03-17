from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Sequence


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SNAPSHOT_PATH = Path(__file__).with_name("compiled_plugin_contract.snapshot.json")

# Keep this in sync with frameos/src/frameos/types.nim.
#
# Bump COMPILED_PLUGIN_ABI_VERSION when an older compiled scene/driver .so may
# no longer be safely loadable by a newer FrameOS binary. In practice that
# means changes to the binary/plugin boundary, for example:
# - fields/layout of CompiledScenePlugin, CompiledDriverPlugin, ExportedScene,
#   ExportedDriver, or CompiledRuntimeHooks
# - exported symbol names such as getCompiledScenePlugin,
#   getCompiledDriverPlugin, or bindCompiledPluginRuntimeChannels
# - proc signatures used across the plugin boundary
#
# Do not bump this for ordinary scene/driver source changes. Those are already
# covered by per-module source hashes.
COMPILED_PLUGIN_ABI_VERSION = 1

# Manual invalidation knob for published compiled modules.
#
# Bump COMPILED_MODULE_BUILD_EPOCH when the plugin ABI is still compatible, but
# you want to force republishing compiled .so files anyway, for example:
# - Nim/compiler or linker changes
# - sysroot/libc/toolchain changes
# - packaging/layout policy changes
# - manual global invalidation
COMPILED_MODULE_BUILD_EPOCH = 1

CONTRACT_GUARD_FILES: tuple[str, ...] = (
    "backend/app/codegen/drivers_nim.py",
    "backend/app/codegen/scene_nim.py",
    "frameos/src/drivers/plugin_runtime.nim",
    "frameos/src/frameos/channels.nim",
    "frameos/src/frameos/device_setup.nim",
    "frameos/src/frameos/scenes.nim",
    "frameos/src/frameos/types.nim",
)


def _normalize_source(text: str) -> str:
    normalized_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        normalized_lines.append(re.sub(r"\s+", " ", line))
    return "\n".join(normalized_lines)


def read_nim_compiled_plugin_abi_version(repo_root: Path | None = None) -> int:
    root = (repo_root or DEFAULT_REPO_ROOT).resolve()
    types_path = root / "frameos" / "src" / "frameos" / "types.nim"
    match = re.search(
        r"COMPILED_PLUGIN_ABI_VERSION\*\s*=\s*(\d+)",
        types_path.read_text(encoding="utf-8"),
    )
    if not match:
        raise RuntimeError(f"Could not parse COMPILED_PLUGIN_ABI_VERSION from {types_path}")
    return int(match.group(1))


def compute_compiled_plugin_boundary_hash(repo_root: Path | None = None) -> str:
    root = (repo_root or DEFAULT_REPO_ROOT).resolve()
    digest = hashlib.sha256()
    for relative_path in CONTRACT_GUARD_FILES:
        path = root / relative_path
        digest.update(f"path:{relative_path}\n".encode("utf-8"))
        digest.update(_normalize_source(path.read_text(encoding="utf-8")).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def build_compiled_plugin_contract_snapshot(repo_root: Path | None = None) -> dict[str, Any]:
    root = (repo_root or DEFAULT_REPO_ROOT).resolve()
    return {
        "abi_version": COMPILED_PLUGIN_ABI_VERSION,
        "boundary_hash": compute_compiled_plugin_boundary_hash(root),
        "files": list(CONTRACT_GUARD_FILES),
    }


def read_compiled_plugin_contract_snapshot(path: Path | None = None) -> dict[str, Any]:
    snapshot_path = (path or DEFAULT_SNAPSHOT_PATH).resolve()
    return json.loads(snapshot_path.read_text(encoding="utf-8"))


def write_compiled_plugin_contract_snapshot(
    path: Path | None = None,
    *,
    repo_root: Path | None = None,
) -> Path:
    snapshot_path = (path or DEFAULT_SNAPSHOT_PATH).resolve()
    payload = build_compiled_plugin_contract_snapshot(repo_root)
    snapshot_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return snapshot_path


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compiled plugin ABI contract helpers")
    subparsers = parser.add_subparsers(dest="command", required=True)

    show = subparsers.add_parser("show-snapshot", help="Print the current compiled-plugin contract snapshot")
    show.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))

    write = subparsers.add_parser("write-snapshot", help="Write the current compiled-plugin contract snapshot")
    write.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT))
    write.add_argument("--output", default=str(DEFAULT_SNAPSHOT_PATH))

    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.command == "show-snapshot":
        print(json.dumps(build_compiled_plugin_contract_snapshot(Path(args.repo_root)), indent=2))
        return 0
    if args.command == "write-snapshot":
        print(
            write_compiled_plugin_contract_snapshot(
                Path(args.output),
                repo_root=Path(args.repo_root),
            )
        )
        return 0
    raise SystemExit(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
