from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from app.codegen.drivers_nim import (
    driver_compile_id,
    driver_library_filename,
    driver_module_name,
    driver_module_name_from_id,
    loadable_drivers,
)
from app.codegen.scene_nim import scene_library_filename, scene_module_name
from app.drivers.drivers import Driver
from app.utils.compiled_plugin_contract import (
    COMPILED_MODULE_BUILD_EPOCH,
    COMPILED_PLUGIN_ABI_VERSION,
)


MANIFEST_VERSION = 1

FULL_DEPLOY = "full"
SMART_DEPLOY = "smart"
FAST_RELOAD = "fast_reload"

EXCLUDED_DIR_NAMES = {
    "__pycache__",
    ".git",
    ".pytest_cache",
    "build",
    "dist",
    "nimcache",
    "node_modules",
    "testresults",
    "tests",
    "tmp",
}

SCENE_RUNTIME_PATHS = (
    "src/frameos/apps.nim",
    "src/frameos/channels.nim",
    "src/frameos/types.nim",
    "src/frameos/values.nim",
    "src/frameos/utils",
)

APP_CORE_PATHS = (
    "config.nims",
    "frameos.nimble",
    "nim.cfg",
    "quickjs",
    "src/drivers/drivers.nim",
    "src/drivers/plugin_runtime.nim",
    "src/frameos",
    "src/frameos.nim",
    "src/system",
    "tools",
    "assets",
    "frontend",
)

APP_SHARED_REPO_PATHS = (
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "versions.json",
    "frontend/package.json",
    "frontend/schema",
    "frontend/src",
)

DRIVER_SHARED_SOURCE_PATHS = (
    "src/frameos/driver_setup.nim",
)


@dataclass(frozen=True, slots=True)
class SceneCompileState:
    hash: str
    library: str


@dataclass(frozen=True, slots=True)
class DriverCompileState:
    hash: str
    library: str


@dataclass(frozen=True, slots=True)
class CompileManifest:
    version: int
    frameos_version: str | None
    runtime_contract_hash: str
    app_hash: str
    scene_hashes: dict[str, SceneCompileState]
    driver_hashes: dict[str, DriverCompileState]

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "frameos_version": self.frameos_version,
            "runtime_contract_hash": self.runtime_contract_hash,
            "app_hash": self.app_hash,
            "scene_hashes": {
                scene_id: {
                    "hash": state.hash,
                    "library": state.library,
                }
                for scene_id, state in self.scene_hashes.items()
            },
            "driver_hashes": {
                driver_id: {
                    "hash": state.hash,
                    "library": state.library,
                }
                for driver_id, state in self.driver_hashes.items()
            },
        }


@dataclass(frozen=True, slots=True)
class CompilePlan:
    mode: str
    rebuild_app: bool
    rebuild_scene_ids: tuple[str, ...]
    reuse_scene_ids: tuple[str, ...]
    rebuild_driver_ids: tuple[str, ...]
    reuse_driver_ids: tuple[str, ...]
    reason: str

    @property
    def needs_compilation(self) -> bool:
        return self.rebuild_app or bool(self.rebuild_scene_ids) or bool(self.rebuild_driver_ids)

    @property
    def rebuild_all_scenes(self) -> bool:
        return bool(self.rebuild_scene_ids) and not self.reuse_scene_ids

    @property
    def scene_build_dirs(self) -> list[str]:
        return [f"scene_builds/{scene_module_name(scene_id)}" for scene_id in self.rebuild_scene_ids]

    @property
    def driver_build_dirs(self) -> list[str]:
        return [f"driver_builds/{driver_module_name_from_id(driver_id)}" for driver_id in self.rebuild_driver_ids]


def compile_manifest_from_dict(value: Any) -> CompileManifest | None:
    if not isinstance(value, dict):
        return None

    version = value.get("version")
    runtime_contract_hash = value.get("runtime_contract_hash")
    app_hash = value.get("app_hash")
    scene_hashes_raw = value.get("scene_hashes")
    driver_hashes_raw = value.get("driver_hashes") or {}
    frameos_version = value.get("frameos_version")

    if version != MANIFEST_VERSION:
        return None
    if not isinstance(runtime_contract_hash, str) or not isinstance(app_hash, str):
        return None
    if frameos_version is not None and not isinstance(frameos_version, str):
        return None
    if not isinstance(scene_hashes_raw, dict) or not isinstance(driver_hashes_raw, dict):
        return None

    scene_hashes: dict[str, SceneCompileState] = {}
    for scene_id, scene_state in scene_hashes_raw.items():
        if not isinstance(scene_id, str) or not isinstance(scene_state, dict):
            return None
        scene_hash = scene_state.get("hash")
        scene_library = scene_state.get("library")
        if not isinstance(scene_hash, str) or not isinstance(scene_library, str):
            return None
        scene_hashes[scene_id] = SceneCompileState(hash=scene_hash, library=scene_library)

    driver_hashes: dict[str, DriverCompileState] = {}
    for driver_id, driver_state in driver_hashes_raw.items():
        if not isinstance(driver_id, str) or not isinstance(driver_state, dict):
            return None
        driver_hash = driver_state.get("hash")
        driver_library = driver_state.get("library")
        if not isinstance(driver_hash, str) or not isinstance(driver_library, str):
            return None
        driver_hashes[driver_id] = DriverCompileState(hash=driver_hash, library=driver_library)

    return CompileManifest(
        version=version,
        frameos_version=frameos_version,
        runtime_contract_hash=runtime_contract_hash,
        app_hash=app_hash,
        scene_hashes=scene_hashes,
        driver_hashes=driver_hashes,
    )


def build_compile_manifest(
    *,
    source_dir: str,
    scenes: list[dict] | None,
    drivers: dict[str, Driver] | None = None,
    frameos_version: str | None,
) -> CompileManifest:
    source_root = Path(source_dir).resolve()
    temp_root = source_root.parent

    runtime_contract_hash = _hash_entries(
        [
            ("compiled_plugin_abi_version", str(COMPILED_PLUGIN_ABI_VERSION).encode("utf-8")),
            *_entries_for_relative_paths(source_root, SCENE_RUNTIME_PATHS),
        ],
    )

    app_hash = _hash_entries(
        [
            *_entries_for_relative_paths(source_root, APP_CORE_PATHS),
            *_entries_for_relative_paths(temp_root, APP_SHARED_REPO_PATHS),
            *_builtin_app_entries(source_root),
        ],
    )

    compiled_scenes = sorted(
        (scene for scene in (scenes or []) if _scene_execution(scene) != "interpreted"),
        key=lambda scene: str(scene.get("id") or "default"),
    )
    scene_hashes: dict[str, SceneCompileState] = {}
    for scene in compiled_scenes:
        scene_id = str(scene.get("id") or "default")
        module_name = scene_module_name(scene_id)
        library = scene_library_filename(scene_id)
        scene_hash = _hash_entries(
            [
                ("runtime_contract", runtime_contract_hash.encode("utf-8")),
                (
                    f"scene_source/{module_name}.nim",
                    source_root / "src" / "scenes" / f"scene_{module_name}.nim",
                ),
                (
                    f"scene_plugin/{module_name}.nim",
                    source_root / "src" / "scenes" / f"plugin_{module_name}.nim",
                ),
                ("module_build_epoch", str(COMPILED_MODULE_BUILD_EPOCH).encode("utf-8")),
                *_scene_app_entries(source_root, scene),
            ],
        )
        scene_hashes[scene_id] = SceneCompileState(hash=scene_hash, library=library)

    driver_hashes: dict[str, DriverCompileState] = {}
    for driver in loadable_drivers(drivers or {}):
        driver_id = driver_compile_id(driver)
        module_name = driver_module_name(driver)
        library = driver_library_filename(driver)
        driver_hash = _hash_entries(
            [
                ("runtime_contract", runtime_contract_hash.encode("utf-8")),
                (
                    f"driver_plugin/{module_name}.nim",
                    source_root / "src" / "driver_plugins" / f"plugin_{module_name}.nim",
                ),
                ("module_build_epoch", str(COMPILED_MODULE_BUILD_EPOCH).encode("utf-8")),
                *_driver_source_entries(source_root, driver),
            ],
        )
        driver_hashes[driver_id] = DriverCompileState(hash=driver_hash, library=library)

    return CompileManifest(
        version=MANIFEST_VERSION,
        frameos_version=frameos_version,
        runtime_contract_hash=runtime_contract_hash,
        app_hash=app_hash,
        scene_hashes=scene_hashes,
        driver_hashes=driver_hashes,
    )


def plan_compile_actions(
    *,
    mode: str,
    previous: CompileManifest | None,
    current: CompileManifest,
) -> CompilePlan:
    current_scene_ids = tuple(sorted(current.scene_hashes))
    current_driver_ids = tuple(sorted(current.driver_hashes))
    if mode == FULL_DEPLOY:
        return CompilePlan(
            mode=mode,
            rebuild_app=True,
            rebuild_scene_ids=current_scene_ids,
            reuse_scene_ids=(),
            rebuild_driver_ids=current_driver_ids,
            reuse_driver_ids=(),
            reason="Full deploy requested",
        )

    if previous is None:
        return CompilePlan(
            mode=mode,
            rebuild_app=True,
            rebuild_scene_ids=current_scene_ids,
            reuse_scene_ids=(),
            rebuild_driver_ids=current_driver_ids,
            reuse_driver_ids=(),
            reason="No previous compile manifest available",
        )

    if previous.runtime_contract_hash != current.runtime_contract_hash:
        return CompilePlan(
            mode=mode,
            rebuild_app=True,
            rebuild_scene_ids=current_scene_ids,
            reuse_scene_ids=(),
            rebuild_driver_ids=current_driver_ids,
            reuse_driver_ids=(),
            reason="Compiled scene runtime contract changed",
        )

    version_changed = previous.frameos_version != current.frameos_version
    rebuild_app = version_changed or previous.app_hash != current.app_hash
    rebuild_scene_ids = tuple(
        scene_id
        for scene_id in current_scene_ids
        if previous.scene_hashes.get(scene_id) != current.scene_hashes[scene_id]
    )
    reuse_scene_ids = tuple(
        scene_id for scene_id in current_scene_ids if scene_id not in rebuild_scene_ids
    )
    rebuild_driver_ids = tuple(
        driver_id
        for driver_id in current_driver_ids
        if previous.driver_hashes.get(driver_id) != current.driver_hashes[driver_id]
    )
    reuse_driver_ids = tuple(
        driver_id for driver_id in current_driver_ids if driver_id not in rebuild_driver_ids
    )

    if version_changed and rebuild_scene_ids and rebuild_driver_ids:
        reason = "FrameOS version changed; compiled scene inputs and driver inputs changed"
    elif version_changed and rebuild_scene_ids:
        reason = "FrameOS version changed; compiled scene inputs changed"
    elif version_changed and rebuild_driver_ids:
        reason = "FrameOS version changed; driver inputs changed"
    elif version_changed:
        reason = "FrameOS version changed"
    elif rebuild_app and rebuild_scene_ids and rebuild_driver_ids:
        reason = "App inputs and compiled scene inputs and driver inputs changed"
    elif rebuild_app and rebuild_scene_ids:
        reason = "App inputs and compiled scene inputs changed"
    elif rebuild_app and rebuild_driver_ids:
        reason = "App inputs and driver inputs changed"
    elif rebuild_app:
        reason = "App inputs changed"
    elif rebuild_scene_ids and rebuild_driver_ids:
        reason = "Compiled scene inputs and driver inputs changed"
    elif rebuild_scene_ids:
        reason = "Compiled scene inputs changed"
    elif rebuild_driver_ids:
        reason = "Driver inputs changed"
    else:
        reason = "Compile inputs unchanged"

    return CompilePlan(
        mode=mode,
        rebuild_app=rebuild_app,
        rebuild_scene_ids=rebuild_scene_ids,
        reuse_scene_ids=reuse_scene_ids,
        rebuild_driver_ids=rebuild_driver_ids,
        reuse_driver_ids=reuse_driver_ids,
        reason=reason,
    )


def _entries_for_relative_paths(root: Path, relative_paths: Iterable[str]) -> list[tuple[str, Path]]:
    return [(relative_path, root / relative_path) for relative_path in relative_paths]


def _hash_entries(entries: Iterable[tuple[str, Path | bytes]]) -> str:
    digest = hashlib.sha256()
    for label, entry in sorted(entries, key=lambda item: item[0]):
        digest.update(f"entry:{label}\n".encode("utf-8"))
        if isinstance(entry, bytes):
            digest.update(entry)
            digest.update(b"\n")
            continue
        _update_digest_for_path(digest, label, entry)
    return digest.hexdigest()


def _update_digest_for_path(digest: Any, label: str, path: Path) -> None:
    if not path.exists():
        digest.update(f"missing:{label}\n".encode("utf-8"))
        return

    if path.is_file():
        digest.update(f"path:{label}\n".encode("utf-8"))
        digest.update(path.read_bytes())
        digest.update(b"\n")
        return

    files = sorted(
        candidate
        for candidate in path.rglob("*")
        if candidate.is_file() and not _should_skip_path(candidate, base_dir=path)
    )
    if not files:
        digest.update(f"empty:{label}\n".encode("utf-8"))
        return

    for candidate in files:
        relative = candidate.relative_to(path).as_posix()
        digest.update(f"path:{label}/{relative}\n".encode("utf-8"))
        digest.update(candidate.read_bytes())
        digest.update(b"\n")


def _should_skip_path(path: Path, *, base_dir: Path) -> bool:
    try:
        relative = path.relative_to(base_dir)
    except ValueError:
        return False
    return any(part in EXCLUDED_DIR_NAMES for part in relative.parts[:-1])


def _builtin_app_entries(source_root: Path) -> list[tuple[str, Path]]:
    apps_root = source_root / "src" / "apps"
    if not apps_root.is_dir():
        return []

    entries: list[tuple[str, Path]] = []
    for category_dir in sorted(apps_root.iterdir()):
        if not category_dir.is_dir():
            continue
        if category_dir.name.startswith("nodeapp_"):
            continue
        for app_dir in sorted(category_dir.iterdir()):
            if not app_dir.is_dir():
                continue
            if not (app_dir / "config.json").exists():
                continue
            entries.append((f"apps/{category_dir.name}/{app_dir.name}", app_dir))
    return entries


def _scene_app_entries(source_root: Path, scene: dict) -> list[tuple[str, Path]]:
    entries: list[tuple[str, Path]] = []
    for app_id in sorted(_scene_app_ids(scene)):
        app_path = source_root / "src" / "apps" / Path(app_id)
        entries.append((f"scene_app/{app_id}", app_path))
    return entries


def _driver_source_entries(source_root: Path, driver: Driver) -> list[tuple[str, Path]]:
    if not driver.import_path:
        return []

    entries: list[tuple[str, Path]] = []
    driver_id = driver_compile_id(driver)
    driver_root_name = Path(driver.import_path).parts[0]
    entries.append((f"driver_source/{driver_id}", source_root / "src" / "drivers" / driver_root_name))

    if driver.name == "inkyHyperPixel2r":
        entries.append((f"driver_support/{driver_id}/frameBuffer", source_root / "src" / "drivers" / "frameBuffer"))
    if driver.name in {"gpioButton", "waveshare"}:
        entries.append((f"driver_support/{driver_id}/lib", source_root / "src" / "lib"))
    if driver.name == "waveshare":
        entries.append((f"driver_support/{driver_id}/generated", source_root / "src" / "drivers" / "waveshare" / "driver.nim"))
    for relative_path in DRIVER_SHARED_SOURCE_PATHS:
        entries.append((f"driver_support/{driver_id}/{relative_path}", source_root / relative_path))

    return entries


def _scene_app_ids(scene: dict) -> set[str]:
    app_ids: set[str] = set()
    for node in scene.get("nodes", []) or []:
        if node.get("type") != "app":
            continue
        sources = node.get("data", {}).get("sources") or {}
        if sources:
            node_id = str(node.get("id") or "")
            app_ids.add(f"nodeapp_{node_id.replace('-', '_')}")
            continue
        keyword = node.get("data", {}).get("keyword")
        if isinstance(keyword, str) and keyword:
            app_ids.add(keyword)
    return app_ids


def _scene_execution(scene: dict) -> str:
    return str(scene.get("settings", {}).get("execution", "compiled"))
