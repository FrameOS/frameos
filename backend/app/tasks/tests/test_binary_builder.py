from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.codegen.drivers_nim import COMPILATION_MODE_PRECOMPILED, COMPILATION_MODE_SHARED, COMPILATION_MODE_STATIC
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryPlan
from app.tasks.precompiled_frameos import PrecompiledFrameOSResult, release_version
from app.utils.cross_compile import TargetMetadata


class FakeDeployer:
    def __init__(self) -> None:
        self.build_id = "build12345678"

    async def make_local_modifications(
        self, _source_dir: str, compilation_mode: str = COMPILATION_MODE_SHARED
    ) -> None:
        return None

    def create_local_source_folder(self, _temp_dir: str, source_root: str | None = None) -> str:
        return source_root or "/tmp/source"

    async def create_local_build_archive(
        self,
        _build_dir: str,
        _source_dir: str,
        _arch: str,
        compilation_mode: str = COMPILATION_MODE_SHARED,
    ) -> str:
        return "/tmp/build.tar.gz"

    def driver_library_paths(self, _build_dir, _drivers, _compilation_mode):
        return []

    def driver_library_names(self, _drivers, _compilation_mode):
        return []

    def scene_library_paths(self, _build_dir, _frame, _compilation_mode):
        return []

    def scene_library_names(self, _frame, _compilation_mode):
        return []


@pytest.mark.asyncio
async def test_plan_build_defaults_to_static_compilation_mode(monkeypatch: pytest.MonkeyPatch):
    async def fake_resolve_prebuilt_entry(**_kwargs):
        return None, None

    monkeypatch.setattr("app.tasks.binary_builder.get_build_host_config", lambda _db: None)
    monkeypatch.setattr("app.tasks.binary_builder.resolve_prebuilt_entry", fake_resolve_prebuilt_entry)

    builder = FrameBinaryBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[], rpios={}),
        deployer=FakeDeployer(),
        temp_dir="/tmp",
    )

    plan = await builder.plan_build(
        target_override=TargetMetadata(arch="aarch64", distro="raspios", version="trixie")
    )
    explicit_shared_plan = await builder.plan_build(
        target_override=TargetMetadata(arch="aarch64", distro="raspios", version="trixie"),
        compilation_mode=COMPILATION_MODE_SHARED,
    )

    assert plan.compilation_mode == COMPILATION_MODE_STATIC
    assert explicit_shared_plan.compilation_mode == COMPILATION_MODE_SHARED


@pytest.mark.asyncio
async def test_plan_build_attempts_precompiled_when_all_scenes_are_interpreted(monkeypatch: pytest.MonkeyPatch):
    async def fake_resolve_prebuilt_entry(**_kwargs):
        return None, "debian-trixie-arm64"

    monkeypatch.setattr("app.tasks.binary_builder.get_build_host_config", lambda _db: None)
    monkeypatch.setattr("app.tasks.binary_builder.resolve_prebuilt_entry", fake_resolve_prebuilt_entry)

    builder = FrameBinaryBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(
            device="framebuffer",
            gpio_buttons=[],
            rpios={"compilationMode": "precompiled"},
            scenes=[{"settings": {"execution": "interpreted"}}],
        ),
        deployer=FakeDeployer(),
        temp_dir="/tmp",
    )

    plan = await builder.plan_build(
        target_override=TargetMetadata(arch="aarch64", distro="debian", version="trixie")
    )

    assert plan.compilation_mode == COMPILATION_MODE_PRECOMPILED
    assert plan.will_attempt_precompiled is True
    assert plan.will_attempt_cross_compile is False
    assert plan.precompiled_release_url is not None
    assert plan.precompiled_release_url.endswith(
        f"/frameos-{release_version()}-debian-trixie-arm64.tar.gz"
    )
    assert plan.precompiled_skip_reason is None


@pytest.mark.asyncio
async def test_plan_build_skips_precompiled_when_compiled_scenes_exist(monkeypatch: pytest.MonkeyPatch):
    async def fake_resolve_prebuilt_entry(**_kwargs):
        return None, "debian-trixie-arm64"

    monkeypatch.setattr("app.tasks.binary_builder.get_build_host_config", lambda _db: None)
    monkeypatch.setattr("app.tasks.binary_builder.resolve_prebuilt_entry", fake_resolve_prebuilt_entry)

    builder = FrameBinaryBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(
            device="framebuffer",
            gpio_buttons=[],
            rpios={"compilationMode": "precompiled"},
            scenes=[{"settings": {"execution": "compiled"}}],
        ),
        deployer=FakeDeployer(),
        temp_dir="/tmp",
    )

    plan = await builder.plan_build(
        target_override=TargetMetadata(arch="aarch64", distro="debian", version="trixie")
    )

    assert plan.compilation_mode == COMPILATION_MODE_PRECOMPILED
    assert plan.will_attempt_precompiled is False
    assert plan.will_attempt_cross_compile is True
    assert plan.precompiled_skip_reason == "1 compiled scene is configured"


@pytest.mark.asyncio
async def test_build_passes_plan_fields_to_cross_compile(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, object] = {}

    async def fake_build_binary_with_cross_toolchain(**kwargs):
        captured.update(kwargs)
        return "/tmp/frameos"

    monkeypatch.setattr("app.tasks.binary_builder.get_build_host_config", lambda _db: None)
    monkeypatch.setattr("app.tasks.binary_builder.build_binary_with_cross_toolchain", fake_build_binary_with_cross_toolchain)

    builder = FrameBinaryBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        deployer=FakeDeployer(),
        temp_dir="/tmp",
    )
    plan = FrameBinaryPlan(
        build_id="build12345678",
        target=TargetMetadata(arch="aarch64", distro="raspios", version="trixie"),
        compilation_mode="static",
        allow_cross_compile=True,
        force_cross_compile=False,
        cross_compile_supported=True,
        build_host_configured=False,
        will_attempt_cross_compile=True,
        prebuilt_entry=None,
        prebuilt_target="debian-trixie-arm64",
    )

    result = await builder.build(plan)

    assert result.cross_compiled is True
    assert result.binary_path == "/tmp/frameos"
    assert captured["target_override"] == plan.target
    assert captured["prebuilt_entry"] is plan.prebuilt_entry
    assert captured["prebuilt_target"] == plan.prebuilt_target


@pytest.mark.asyncio
async def test_build_uses_precompiled_release_when_planned(monkeypatch: pytest.MonkeyPatch, tmp_path):
    async def fake_download_precompiled_frameos_release(**kwargs):
        build_dir = kwargs["build_dir"]
        binary_path = f"{build_dir}/frameos"
        driver_path = f"{build_dir}/drivers/frameBuffer.so"
        archive_path = f"{build_dir}.tar.gz"
        import os

        os.makedirs(f"{build_dir}/drivers", exist_ok=True)
        with open(binary_path, "wb") as fh:
            fh.write(b"frameos")
        with open(driver_path, "wb") as fh:
            fh.write(b"driver")
        with open(archive_path, "wb") as fh:
            fh.write(b"archive")
        return PrecompiledFrameOSResult(
            release_url="https://example.test/frameos.tar.gz",
            binary_path=binary_path,
            driver_library_paths=[driver_path],
            driver_library_names=["frameBuffer.so"],
            scene_library_paths=[],
            scene_library_names=[],
            vendor_folders=[],
            archive_path=archive_path,
        )

    monkeypatch.setattr("app.tasks.binary_builder.get_build_host_config", lambda _db: None)
    monkeypatch.setattr(
        "app.tasks.binary_builder.download_precompiled_frameos_release",
        fake_download_precompiled_frameos_release,
    )

    builder = FrameBinaryBuilder(
        db=None,
        redis=None,
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[], scenes=[]),
        deployer=FakeDeployer(),
        temp_dir=str(tmp_path),
    )
    plan = FrameBinaryPlan(
        build_id="build12345678",
        target=TargetMetadata(arch="aarch64", distro="debian", version="trixie"),
        compilation_mode="precompiled",
        allow_cross_compile=True,
        force_cross_compile=False,
        cross_compile_supported=True,
        build_host_configured=False,
        will_attempt_cross_compile=False,
        prebuilt_entry=None,
        prebuilt_target="debian-trixie-arm64",
        will_attempt_precompiled=True,
        precompiled_release_url="https://example.test/frameos.tar.gz",
    )

    result = await builder.build(plan)

    assert result.precompiled is True
    assert result.cross_compiled is True
    assert result.binary_path and result.binary_path.endswith("/frameos")
    assert result.driver_library_names == ["frameBuffer.so"]
