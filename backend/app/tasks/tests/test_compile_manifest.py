from pathlib import Path

from app.drivers.drivers import Driver
from app.tasks.compile_manifest import (
    FULL_DEPLOY,
    SMART_DEPLOY,
    build_compile_manifest,
    compile_manifest_from_dict,
    plan_compile_actions,
)


def write(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def create_source_tree(tmp_path: Path) -> Path:
    temp_root = tmp_path / "work"
    source_dir = temp_root / "frameos"

    write(temp_root / "package.json", "{}\n")
    write(temp_root / "pnpm-workspace.yaml", "packages:\n  - frontend\n")
    write(temp_root / "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    write(temp_root / "versions.json", '{"frameos":"1.0.0"}\n')
    write(temp_root / "frontend" / "package.json", "{}\n")
    write(temp_root / "frontend" / "src" / "initKea.ts", "export const initKea = true\n")
    write(temp_root / "frontend" / "schema" / "events.json", "{}\n")

    write(source_dir / "config.nims", "switch(\"define\", \"release\")\n")
    write(source_dir / "frameos.nimble", "version = \"0.1.0\"\n")
    write(source_dir / "nim.cfg", "--threads:on\n")
    write(source_dir / "src" / "frameos.nim", "import frameos/frameos\n")
    write(source_dir / "src" / "frameos" / "apps.nim", "proc renderWidth*(): int = 1\n")
    write(source_dir / "src" / "frameos" / "channels.nim", "discard\n")
    write(source_dir / "src" / "frameos" / "driver_setup.nim", "type DriverSetupSpec* = ref object\n")
    write(source_dir / "src" / "frameos" / "types.nim", "type SceneId* = distinct string\n")
    write(source_dir / "src" / "frameos" / "values.nim", "discard\n")
    write(source_dir / "src" / "frameos" / "utils" / "image.nim", "discard\n")
    write(source_dir / "src" / "frameos" / "utils" / "time.nim", "discard\n")
    write(source_dir / "src" / "system" / "scenes.nim", "discard\n")
    write(source_dir / "src" / "drivers" / "drivers.nim", "discard\n")
    write(source_dir / "src" / "drivers" / "plugin_runtime.nim", "discard\n")
    write(source_dir / "src" / "drivers" / "frameBuffer" / "frameBuffer.nim", "discard\n")
    write(source_dir / "src" / "drivers" / "inkyHyperPixel2r" / "inkyHyperPixel2r.nim", "discard\n")
    write(source_dir / "src" / "driver_plugins" / "plugin_frameBuffer.nim", "discard\n")
    write(source_dir / "src" / "driver_plugins" / "plugin_inkyHyperPixel2r.nim", "discard\n")
    write(source_dir / "tools" / "prepare_assets.py", "print('assets')\n")
    write(source_dir / "assets" / "compiled" / "web" / "control.html", "<html></html>\n")
    write(source_dir / "frontend" / "package.json", "{}\n")
    write(source_dir / "frontend" / "src" / "main.tsx", "export const frame = true\n")
    write(source_dir / "quickjs" / "quickjs.h", "/* quickjs */\n")

    write(source_dir / "src" / "apps" / "data" / "clock" / "app.nim", "proc get*(): int = 1\n")
    write(source_dir / "src" / "apps" / "data" / "clock" / "config.json", '{"name":"Clock"}\n')
    write(source_dir / "src" / "apps" / "render" / "text" / "app.nim", "proc render*() = discard\n")
    write(source_dir / "src" / "apps" / "render" / "text" / "config.json", '{"name":"Text"}\n')

    write(source_dir / "src" / "scenes" / "scene_demo.nim", "import apps/data/clock/app\n")
    write(source_dir / "src" / "scenes" / "plugin_demo.nim", "proc getCompiledScenePlugin*() = discard\n")
    write(source_dir / "src" / "apps" / "nodeapp_demo_node" / "app.nim", "proc get*(): int = 2\n")
    write(source_dir / "src" / "apps" / "nodeapp_demo_node" / "config.json", '{"name":"Node Demo"}\n')
    write(source_dir / "src" / "scenes" / "scene_custom.nim", "import apps/nodeapp_demo_node/app\n")
    write(source_dir / "src" / "scenes" / "plugin_custom.nim", "proc getCompiledScenePlugin*() = discard\n")

    return source_dir


def runtime_drivers() -> dict[str, Driver]:
    return {
        "frameBuffer": Driver(
            name="frameBuffer",
            import_path="frameBuffer/frameBuffer",
            can_render=True,
            can_turn_on_off=True,
        )
    }


def runtime_drivers_with_shared_setup() -> dict[str, Driver]:
    return {
        "inkyHyperPixel2r": Driver(
            name="inkyHyperPixel2r",
            import_path="inkyHyperPixel2r/inkyHyperPixel2r",
            can_render=True,
            can_turn_on_off=True,
        )
    }


def test_build_compile_manifest_hashes_app_and_compiled_scenes_independently(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [
        {
            "id": "demo",
            "nodes": [{"id": "clock-node", "type": "app", "data": {"keyword": "data/clock"}}],
            "settings": {"execution": "compiled"},
        },
        {
            "id": "custom",
            "nodes": [{"id": "demo-node", "type": "app", "data": {"sources": {"app.nim": "discard"}}}],
            "settings": {"execution": "compiled"},
        },
    ]

    before = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=scenes,
        frameos_version="1.0.0",
    )

    write(source_dir / "src" / "apps" / "nodeapp_demo_node" / "app.nim", "proc get*(): int = 3\n")
    after = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=scenes,
        frameos_version="1.0.0",
    )

    assert before.app_hash == after.app_hash
    assert before.scene_hashes["demo"] == after.scene_hashes["demo"]
    assert before.scene_hashes["custom"] != after.scene_hashes["custom"]


def test_plan_compile_actions_only_rebuilds_runtime_when_version_changes(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [{"id": "demo", "nodes": [], "settings": {"execution": "compiled"}}]
    current = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="2.0.0")
    previous = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=previous, current=current)

    assert plan.rebuild_app is True
    assert plan.rebuild_scene_ids == ()
    assert plan.reuse_scene_ids == ("demo",)
    assert plan.rebuild_driver_ids == ()
    assert plan.reuse_driver_ids == ()
    assert plan.reason == "FrameOS version changed"


def test_plan_compile_actions_rebuilds_everything_when_runtime_contract_changes(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [{"id": "demo", "nodes": [], "settings": {"execution": "compiled"}}]
    previous = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    write(source_dir / "src" / "frameos" / "types.nim", "type SceneId* = distinct int\n")
    current = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=previous, current=current)

    assert plan.rebuild_app is True
    assert plan.rebuild_scene_ids == ("demo",)
    assert plan.rebuild_driver_ids == ()
    assert plan.reason == "Compiled scene runtime contract changed"


def test_plan_compile_actions_rebuilds_only_changed_scene_when_possible(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [
        {
            "id": "custom",
            "nodes": [{"id": "demo-node", "type": "app", "data": {"sources": {"app.nim": "discard"}}}],
            "settings": {"execution": "compiled"},
        },
        {
            "id": "demo",
            "nodes": [{"id": "clock-node", "type": "app", "data": {"keyword": "data/clock"}}],
            "settings": {"execution": "compiled"},
        },
    ]
    previous = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    write(source_dir / "src" / "scenes" / "scene_demo.nim", "import apps/data/clock/app\nlet changed = true\n")
    current = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=previous, current=current)

    assert plan.rebuild_app is False
    assert plan.rebuild_scene_ids == ("demo",)
    assert plan.reuse_scene_ids == ("custom",)
    assert plan.rebuild_driver_ids == ()
    assert plan.reuse_driver_ids == ()
    assert plan.scene_build_dirs == ["scene_builds/demo"]


def test_plan_compile_actions_supports_forced_full_deploy(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [{"id": "demo", "nodes": [], "settings": {"execution": "compiled"}}]
    manifest = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    plan = plan_compile_actions(mode=FULL_DEPLOY, previous=manifest, current=manifest)

    assert plan.rebuild_app is True
    assert plan.rebuild_scene_ids == ("demo",)
    assert plan.rebuild_driver_ids == ()
    assert plan.reason == "Full deploy requested"


def test_compile_manifest_round_trips_through_dict(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scenes = [{"id": "demo", "nodes": [], "settings": {"execution": "compiled"}}]
    manifest = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")

    restored = compile_manifest_from_dict(manifest.to_dict())

    assert restored == manifest


def test_compile_manifest_uses_module_name_for_library_and_build_dir(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    scene_id = "03fe741a-75cf-4653-b77b-d2b42b7e0a94"
    write(
        source_dir / "src" / "scenes" / "scene_03fe741a_75cf_4653_b77b_d2b42b7e0a94.nim",
        "discard\n",
    )
    write(
        source_dir / "src" / "scenes" / "plugin_03fe741a_75cf_4653_b77b_d2b42b7e0a94.nim",
        "discard\n",
    )
    scenes = [{"id": scene_id, "nodes": [], "settings": {"execution": "compiled"}}]

    manifest = build_compile_manifest(source_dir=str(source_dir), scenes=scenes, frameos_version="1.0.0")
    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=None, current=manifest)

    assert manifest.scene_hashes[scene_id].library == "03fe741a_75cf_4653_b77b_d2b42b7e0a94.so"
    assert plan.scene_build_dirs == ["scene_builds/03fe741a_75cf_4653_b77b_d2b42b7e0a94"]


def test_plan_compile_actions_tracks_driver_changes_independently(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    drivers = runtime_drivers()

    previous = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=[],
        drivers=drivers,
        frameos_version="1.0.0",
    )

    write(source_dir / "src" / "driver_plugins" / "plugin_frameBuffer.nim", "let changed = true\n")
    current = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=[],
        drivers=drivers,
        frameos_version="1.0.0",
    )

    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=previous, current=current)

    assert plan.rebuild_app is False
    assert plan.rebuild_scene_ids == ()
    assert plan.reuse_scene_ids == ()
    assert plan.rebuild_driver_ids == ("frameBuffer",)
    assert plan.reuse_driver_ids == ()
    assert plan.driver_build_dirs == ["driver_builds/frameBuffer"]


def test_plan_compile_actions_rebuilds_driver_when_shared_setup_changes(tmp_path: Path):
    source_dir = create_source_tree(tmp_path)
    drivers = runtime_drivers_with_shared_setup()

    previous = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=[],
        drivers=drivers,
        frameos_version="1.0.0",
    )

    write(
        source_dir / "src" / "frameos" / "driver_setup.nim",
        "type DriverSetupSpec* = ref object\nlet changed = true\n",
    )
    current = build_compile_manifest(
        source_dir=str(source_dir),
        scenes=[],
        drivers=drivers,
        frameos_version="1.0.0",
    )

    plan = plan_compile_actions(mode=SMART_DEPLOY, previous=previous, current=current)

    assert plan.rebuild_app is True
    assert plan.rebuild_scene_ids == ()
    assert plan.reuse_scene_ids == ()
    assert plan.rebuild_driver_ids == ("inkyHyperPixel2r",)
    assert plan.reuse_driver_ids == ()
    assert plan.reason == "App inputs and driver inputs changed"
