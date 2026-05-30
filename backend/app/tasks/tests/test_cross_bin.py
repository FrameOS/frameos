from __future__ import annotations

import importlib.util
import json
import shlex
import shutil
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path
from types import SimpleNamespace

import pytest


CROSS_PATH = Path(__file__).resolve().parents[3] / "bin" / "cross"


def load_cross_module():
    loader = SourceFileLoader("frameos_backend_bin_cross_test", str(CROSS_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_generate_agent_build_dir_constructs_versioned_command(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    cross_module = load_cross_module()
    repo_root = tmp_path / "repo"
    agent_source_dir = repo_root / "frameos" / "agent source"
    build_dir = tmp_path / "agent-build"
    nimbase = tmp_path / "nimbase.h"
    repo_root.mkdir()
    agent_source_dir.mkdir(parents=True)
    nimbase.write_text("// nimbase\n", encoding="utf-8")
    (repo_root / "versions.json").write_text('{"agent":"2026.5.14"}\n', encoding="utf-8")

    captured: dict[str, str] = {}

    class FakeDeployer:
        frame = SimpleNamespace(id=1)

        async def arch_to_nim_cpu(self, arch):
            assert arch == "aarch64"
            return "arm64"

    async def fake_exec_local_command(_db, _redis, _frame, command):
        captured["command"] = command
        (build_dir / "compile_frameos_agent.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        return 0, "", ""

    monkeypatch.setattr(
        "backend.app.utils.local_exec.exec_local_command",
        fake_exec_local_command,
    )
    monkeypatch.setattr("backend.app.tasks.utils.find_nimbase_file", lambda _nim_path: str(nimbase))
    monkeypatch.setattr(
        "backend.app.tasks._frame_deployer.FrameDeployer._find_compile_script",
        staticmethod(
            lambda build_dir_arg, _name: str(Path(build_dir_arg) / "compile_frameos_agent.sh")
        ),
    )
    monkeypatch.setattr(
        "backend.app.tasks._frame_deployer.FrameDeployer._extract_compile_flags",
        staticmethod(lambda _script_path, _output_name: ("", "")),
    )
    monkeypatch.setattr(
        "backend.app.tasks._frame_deployer.FrameDeployer._write_c_makefile",
        staticmethod(
            lambda makefile_path, **_kwargs: Path(makefile_path).write_text(
                "all:\n",
                encoding="utf-8",
            )
        ),
    )

    await cross_module.generate_agent_build_dir(
        deployer=FakeDeployer(),
        agent_source_dir=agent_source_dir,
        build_dir=build_dir,
        arch="aarch64",
        nim_path="/opt/nim/bin/nim",
        repo_root=repo_root,
    )

    assert "--define:frameosAgentVersion:2026.5.14" in captured["command"]
    assert shlex.quote(str(agent_source_dir)) in captured["command"]
    assert (build_dir / "nimbase.h").read_text(encoding="utf-8") == "// nimbase\n"
    assert (build_dir / "Makefile").exists()


@pytest.mark.asyncio
async def test_build_target_plans_then_builds(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    cross_module = load_cross_module()
    binary_path = tmp_path / "frameos-bin"
    binary_path.write_bytes(b"frameos")

    class FakeFrameDeployer:
        def __init__(self, db, redis, frame, nim_path, temp_dir):
            self.db = db
            self.redis = redis
            self.frame = frame
            self.nim_path = nim_path
            self.temp_dir = temp_dir
            self.build_id = "build12345678"

    class FakeBinaryBuilder:
        last_plan_kwargs = None
        last_build_plan = None

        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def plan_build(self, **kwargs):
            FakeBinaryBuilder.last_plan_kwargs = kwargs
            return SimpleNamespace(marker="plan", compilation_mode=kwargs.get("compilation_mode") or "static")

        async def build(self, plan):
            FakeBinaryBuilder.last_build_plan = plan
            return SimpleNamespace(
                binary_path=str(binary_path),
                driver_library_paths=[],
                driver_library_names=[],
                scene_library_paths=[],
                scene_library_names=[],
            )

    monkeypatch.setattr("backend.app.tasks._frame_deployer.FrameDeployer", FakeFrameDeployer)
    monkeypatch.setattr("backend.app.tasks.binary_builder.FrameBinaryBuilder", FakeBinaryBuilder)
    monkeypatch.setattr("backend.app.tasks.utils.find_nim_v2", lambda: "/tmp/nim")

    frameos_root = tmp_path / "frameos"
    artifacts_dir = tmp_path / "artifacts"
    frameos_root.mkdir()
    (frameos_root / "versions.json").write_text('{"agent":"2026.5.14"}\n', encoding="utf-8")

    destination = await cross_module.build_target("debian-trixie-amd64", frameos_root, artifacts_dir)

    assert FakeBinaryBuilder.last_plan_kwargs is not None
    assert FakeBinaryBuilder.last_plan_kwargs["allow_cross_compile"] is True
    assert FakeBinaryBuilder.last_plan_kwargs["force_cross_compile"] is True
    assert FakeBinaryBuilder.last_plan_kwargs["target_override"].arch == "amd64"
    assert FakeBinaryBuilder.last_plan_kwargs["target_override"].distro == "debian"
    assert FakeBinaryBuilder.last_plan_kwargs["target_override"].version == "trixie"
    assert getattr(FakeBinaryBuilder.last_build_plan, "marker", None) == "plan"
    assert destination.exists()
    assert destination.read_bytes() == b"frameos"
    metadata = json.loads((artifacts_dir / "debian-trixie-amd64" / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["compilation_mode"] == "static"


@pytest.mark.asyncio
async def test_build_release_target_uses_runtime_filtered_driver_catalog(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    cross_module = load_cross_module()
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))

    class FakeFrameDeployer:
        archive_calls = 0

        def __init__(self, db, redis, frame, nim_path, temp_dir):
            self.db = db
            self.redis = redis
            self.frame = frame
            self.nim_path = nim_path
            self.temp_dir = temp_dir
            self.build_id = "release12345"
            self.modifications_kwargs = None

        async def log(self, *_args, **_kwargs):
            return None

        def create_local_source_folder(self, temp_dir, source_root=None):
            source_dir = Path(temp_dir) / "frameos"
            (source_dir / "agent").mkdir(parents=True)
            (source_dir / "src" / "drivers" / "waveshare").mkdir(parents=True)
            (source_dir / "src" / "drivers" / "shared").mkdir(parents=True)
            (source_dir / "src" / "drivers" / "waveshare" / "waveshare.nim").write_text(
                "import drivers/waveshare/driver as waveshareDriver\n",
                encoding="utf-8",
            )
            shutil.copy2(
                Path(source_root) / "versions.json",
                Path(temp_dir) / "versions.json",
            )
            return str(source_dir)

        async def make_local_modifications(self, source_dir, **kwargs):
            self.modifications_kwargs = kwargs

        async def create_local_build_archive(self, build_dir, source_dir, arch, **kwargs):
            FakeFrameDeployer.archive_calls += 1
            Path(build_dir).mkdir(parents=True, exist_ok=True)
            (Path(build_dir) / "compile_frameos.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (Path(build_dir) / "Makefile").write_text("all:\n", encoding="utf-8")
            driver_dir = Path(build_dir) / "drivers" / "httpUpload"
            driver_dir.mkdir(parents=True)
            (driver_dir / "compile_httpUpload.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            (driver_dir / "Makefile").write_text("all:\n", encoding="utf-8")
            return str(Path(self.temp_dir) / "build_release12345.tar.gz")

        @staticmethod
        def driver_library_paths(build_dir, _drivers, _compilation_mode):
            return [str(Path(build_dir) / "drivers" / "httpUpload" / "httpUpload.so")]

        @staticmethod
        def driver_library_names(_drivers, _compilation_mode):
            return ["httpUpload.so"]

    class FakeCrossCompiler:
        build_calls = 0

        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def build(self, _source_dir):
            FakeCrossCompiler.build_calls += 1
            build_dir = Path(self.kwargs["build_dir"])
            output_name = self.kwargs.get("output_name", "frameos")
            binary_path = build_dir / output_name
            binary_path.write_bytes(b"release-agent" if output_name == "frameos_agent" else b"release-frameos")
            if output_name == "frameos":
                driver_path = build_dir / "drivers" / "httpUpload" / "httpUpload.so"
                driver_path.parent.mkdir(parents=True, exist_ok=True)
                driver_path.write_bytes(b"driver")
            return str(binary_path)

    async def fake_resolve_prebuilt_entry(**_kwargs):
        return None, None

    async def fake_generate_agent_build_dir(**kwargs):
        build_dir = Path(kwargs["build_dir"])
        build_dir.mkdir(parents=True, exist_ok=True)
        (build_dir / "compile_frameos_agent.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (build_dir / "Makefile").write_text("all:\n", encoding="utf-8")

    monkeypatch.setattr("backend.app.tasks._frame_deployer.FrameDeployer", FakeFrameDeployer)
    monkeypatch.setattr("backend.app.tasks.utils.find_nim_v2", lambda: "/tmp/nim")
    monkeypatch.setattr("backend.app.tasks.binary_builder.resolve_prebuilt_entry", fake_resolve_prebuilt_entry)
    monkeypatch.setattr("backend.app.utils.cross_compile.CrossCompiler", FakeCrossCompiler)
    monkeypatch.setattr(cross_module, "generate_agent_build_dir", fake_generate_agent_build_dir)
    monkeypatch.setattr(
        "app.codegen.release_drivers_nim.release_driver_specs",
        lambda: {
            "httpUpload": SimpleNamespace(
                name="httpUpload",
                variant=None,
                import_path="httpUpload/httpUpload",
                vendor_folder=None,
                can_render=True,
                can_png=False,
                can_turn_on_off=False,
                link_flags=(),
            )
        },
    )
    monkeypatch.setattr("app.codegen.release_drivers_nim.write_release_shared_drivers_nim", lambda _drivers: "release drivers")
    monkeypatch.setattr("app.codegen.release_drivers_nim.write_release_waveshare_driver_modules", lambda *_args: None)
    monkeypatch.setattr("app.codegen.release_drivers_nim.write_release_driver_libraries", lambda *_args: None)

    frameos_root = tmp_path / "frameos"
    artifacts_dir = tmp_path / "artifacts"
    frameos_root.mkdir()
    expected_versions = {
        "frameos": "2026.5.15+frameos",
        "agent": "2026.5.16+agent",
        "docker": "2026.5.16+docker",
    }
    (frameos_root / "versions.json").write_text(json.dumps(expected_versions) + "\n", encoding="utf-8")

    destination = await cross_module.build_release_target("debian-trixie-amd64", frameos_root, artifacts_dir)

    assert destination.read_bytes() == b"release-frameos"
    assert (
        artifacts_dir
        / "debian-trixie-amd64"
        / "drivers"
        / "httpUpload.so"
    ).read_bytes() == b"driver"
    assert (artifacts_dir / "debian-trixie-amd64" / "frameos_agent").read_bytes() == b"release-agent"
    metadata = json.loads((artifacts_dir / "debian-trixie-amd64" / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["release_artifact"] is True
    assert metadata["driver_registry"] == "runtime-filtered"
    assert metadata["driver_libraries"] == ["httpUpload.so"]
    assert metadata["agent_binary"] == "frameos_agent"
    assert metadata["input_hash"]
    versions = json.loads((artifacts_dir / "debian-trixie-amd64" / "versions.json").read_text(encoding="utf-8"))
    assert versions == expected_versions
    assert FakeFrameDeployer.archive_calls == 1
    assert FakeCrossCompiler.build_calls == 2

    shutil.rmtree(artifacts_dir / "debian-trixie-amd64")
    restored_destination = await cross_module.build_release_target(
        "debian-trixie-amd64",
        frameos_root,
        artifacts_dir,
    )

    assert restored_destination.read_bytes() == b"release-frameos"
    assert (artifacts_dir / "debian-trixie-amd64" / "versions.json").is_file()
    assert FakeFrameDeployer.archive_calls == 1
    assert FakeCrossCompiler.build_calls == 2


def test_compute_release_input_hash_tracks_source_and_target(tmp_path: Path):
    cross_module = load_cross_module()
    input_root = tmp_path / "input"
    (input_root / "frameos" / "src").mkdir(parents=True)
    source = input_root / "frameos" / "src" / "frameos.nim"
    source.write_text("echo 1\n", encoding="utf-8")

    target = cross_module.TARGET_MAP["debian-trixie-amd64"]
    first_hash = cross_module.compute_release_input_hash(
        slug=target.slug,
        target=target,
        input_root=input_root,
        nim_path="/nix/store/nim-2.2.4/bin/nim",
        driver_library_names=["httpUpload.so"],
    )
    source.write_text("echo 2\n", encoding="utf-8")
    second_hash = cross_module.compute_release_input_hash(
        slug=target.slug,
        target=target,
        input_root=input_root,
        nim_path="/nix/store/nim-2.2.4/bin/nim",
        driver_library_names=["httpUpload.so"],
    )
    arm_target = cross_module.TARGET_MAP["debian-trixie-arm64"]
    arm_hash = cross_module.compute_release_input_hash(
        slug=arm_target.slug,
        target=arm_target,
        input_root=input_root,
        nim_path="/nix/store/nim-2.2.4/bin/nim",
        driver_library_names=["httpUpload.so"],
    )

    assert first_hash != second_hash
    assert second_hash != arm_hash


def test_parse_args_accepts_shared_scenes_compilation_mode():
    cross_module = load_cross_module()
    args = cross_module.parse_args(
        [
            "build",
            "--target",
            "debian-trixie-amd64",
            "--compilation-mode",
            "shared-scenes",
        ]
    )
    assert args.command == "build"
    assert args.compilation_mode == "shared-scenes"
