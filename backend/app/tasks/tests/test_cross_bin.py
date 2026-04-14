from __future__ import annotations

import importlib.util
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
            return SimpleNamespace(marker="plan")

        async def build(self, plan):
            FakeBinaryBuilder.last_build_plan = plan
            return SimpleNamespace(binary_path=str(binary_path))

    monkeypatch.setattr("backend.app.tasks._frame_deployer.FrameDeployer", FakeFrameDeployer)
    monkeypatch.setattr("backend.app.tasks.binary_builder.FrameBinaryBuilder", FakeBinaryBuilder)
    monkeypatch.setattr("backend.app.tasks.utils.find_nim_v2", lambda: "/tmp/nim")

    frameos_root = tmp_path / "frameos"
    artifacts_dir = tmp_path / "artifacts"
    frameos_root.mkdir()

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
