from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryPlan
from app.utils.cross_compile import TargetMetadata


class FakeDeployer:
    def __init__(self) -> None:
        self.build_id = "build12345678"

    async def make_local_modifications(self, _source_dir: str) -> None:
        return None

    def create_local_source_folder(self, _temp_dir: str, source_root: str | None = None) -> str:
        return source_root or "/tmp/source"

    async def create_local_build_archive(self, _build_dir: str, _source_dir: str, _arch: str) -> str:
        return "/tmp/build.tar.gz"


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
        frame=SimpleNamespace(),
        deployer=FakeDeployer(),
        temp_dir="/tmp",
    )
    plan = FrameBinaryPlan(
        build_id="build12345678",
        target=TargetMetadata(arch="aarch64", distro="raspios", version="trixie"),
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
