from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.codegen.drivers_nim import DRIVER_BUILD_MODE_SHARED, DRIVER_BUILD_MODE_STATIC
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryPlan
from app.utils.cross_compile import TargetMetadata


class FakeDeployer:
    def __init__(self) -> None:
        self.build_id = "build12345678"

    async def make_local_modifications(
        self, _source_dir: str, driver_build_mode: str = DRIVER_BUILD_MODE_SHARED
    ) -> None:
        return None

    def create_local_source_folder(self, _temp_dir: str, source_root: str | None = None) -> str:
        return source_root or "/tmp/source"

    async def create_local_build_archive(
        self,
        _build_dir: str,
        _source_dir: str,
        _arch: str,
        driver_build_mode: str = DRIVER_BUILD_MODE_SHARED,
    ) -> str:
        return "/tmp/build.tar.gz"

    def driver_library_paths(self, _build_dir, _drivers, _driver_build_mode):
        return []

    def driver_library_names(self, _drivers, _driver_build_mode):
        return []


@pytest.mark.asyncio
async def test_plan_build_defaults_to_static_driver_mode(monkeypatch: pytest.MonkeyPatch):
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
        driver_build_mode=DRIVER_BUILD_MODE_SHARED,
    )

    assert plan.driver_build_mode == DRIVER_BUILD_MODE_STATIC
    assert explicit_shared_plan.driver_build_mode == DRIVER_BUILD_MODE_SHARED


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
        driver_build_mode="static",
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
