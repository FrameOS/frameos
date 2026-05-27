from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.deploy_agent import AgentDeployer, deploy_agent, deploy_agent_task
from app.tasks.precompiled_agent import PrecompiledAgentResult


class FakeAgentDeployer(AgentDeployer):
    def __init__(self, tmp_path: Path) -> None:
        super().__init__(
            db=None,
            redis=None,
            frame=SimpleNamespace(id=1, debug=False, agent={"agentEnabled": True, "agentSharedSecret": "secret"}),
            nim_path="",
            temp_dir=str(tmp_path),
        )
        self.logs: list[tuple[str, str]] = []
        self.staged_binary: str | None = None
        self.source_arch: str | None = None

    async def log(self, type: str, line: str, timestamp=None):  # type: ignore[override]
        self.logs.append((type, line))

    async def _stage_agent_binary(self, binary_path: str) -> None:  # type: ignore[override]
        self.staged_binary = binary_path

    async def _deploy_agent_from_source(self, arch: str) -> None:  # type: ignore[override]
        self.source_arch = arch


class FakeRedis:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue_job(self, name: str, **kwargs):
        self.jobs.append((name, kwargs))


@pytest.mark.asyncio
async def test_deploy_agent_enqueues_transport():
    redis = FakeRedis()

    await deploy_agent(7, redis, recompile=True, transport="agent")

    assert redis.jobs == [("deploy_agent", {"id": 7, "recompile": True, "transport": "agent"})]


@pytest.mark.asyncio
async def test_deploy_agent_prefers_precompiled_binary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_download_precompiled_agent_release(**kwargs):
        binary_path = tmp_path / "frameos_agent"
        binary_path.write_bytes(b"agent")
        return PrecompiledAgentResult(
            release_url="https://example.test/frameos.tar.gz",
            binary_path=str(binary_path),
            archive_path=str(tmp_path / "archive.tar.gz"),
        )

    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    monkeypatch.setattr(
        deploy_agent_module,
        "find_nim_v2",
        lambda: (_ for _ in ()).throw(RuntimeError("Nim should not be needed")),
    )
    monkeypatch.setattr(
        deploy_agent_module,
        "download_precompiled_agent_release",
        fake_download_precompiled_agent_release,
    )

    deployer = FakeAgentDeployer(tmp_path)
    await deployer._deploy_agent(arch="aarch64", distro="debian", distro_version="trixie")

    assert deployer.staged_binary == str(tmp_path / "frameos_agent")
    assert deployer.source_arch is None
    assert any("precompiled FrameOS release for agent" in message for _level, message in deployer.logs)


@pytest.mark.asyncio
async def test_deploy_agent_can_force_source_build(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_download_precompiled_agent_release(**kwargs):
        raise AssertionError("Precompiled agent should not be used when recompile is requested")

    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    monkeypatch.setattr(
        deploy_agent_module,
        "download_precompiled_agent_release",
        fake_download_precompiled_agent_release,
    )

    deployer = FakeAgentDeployer(tmp_path)
    deployer.force_source = True
    await deployer._deploy_agent(arch="aarch64", distro="debian", distro_version="trixie")

    assert deployer.staged_binary is None
    assert deployer.source_arch == "aarch64"
    assert any("requested from local development" in message for _level, message in deployer.logs)


@pytest.mark.asyncio
async def test_deploy_agent_task_does_not_require_nim_before_running_deployer(
    monkeypatch: pytest.MonkeyPatch,
):
    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    captured: dict[str, object] = {}

    async def fake_run(self):
        captured["ran"] = True
        captured["force_source"] = self.force_source
        captured["transport"] = self.remote_transport

    monkeypatch.setattr(
        deploy_agent_module,
        "find_nim_v2",
        lambda: (_ for _ in ()).throw(RuntimeError("Nim should not be needed")),
    )
    monkeypatch.setattr(deploy_agent_module, "get_fresh_frame", lambda _db, _id: SimpleNamespace(id=1))
    monkeypatch.setattr(AgentDeployer, "run", fake_run)

    await deploy_agent_task({"db": object(), "redis": object()}, id=1, recompile=True, transport="agent")

    assert captured == {"ran": True, "force_source": True, "transport": "agent"}


@pytest.mark.asyncio
async def test_deploy_agent_falls_back_to_source_for_unsupported_target(tmp_path: Path):
    deployer = FakeAgentDeployer(tmp_path)

    await deployer._deploy_agent(arch="mips64", distro="debian", distro_version="trixie")

    assert deployer.staged_binary is None
    assert deployer.source_arch == "mips64"
