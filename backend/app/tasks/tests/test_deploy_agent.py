from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.deploy_agent import AgentDeployer, deploy_agent, deploy_agent_task, resolve_agent_task_transport
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
        self.commands: list[str] = []
        self.command_statuses: list[tuple[str, int]] = []
        self.staged_binary: str | None = None
        self.source_arch: str | None = None
        self.source_distro: str | None = None

    async def log(self, type: str, line: str, timestamp=None):  # type: ignore[override]
        self.logs.append((type, line))

    async def exec_command(  # type: ignore[override]
        self,
        command: str,
        output=None,
        log_output: bool = True,
        log_command=True,
        raise_on_error: bool = True,
        timeout: int = 1800,
    ) -> int:
        self.commands.append(command)
        status = 0
        for needle, configured_status in self.command_statuses:
            if needle in command:
                status = configured_status
                break
        if output is not None:
            output.append("")
        if status != 0 and raise_on_error:
            raise RuntimeError(f"Command failed: {command}")
        return status

    async def _stage_agent_binary(self, binary_path: str) -> None:  # type: ignore[override]
        self.staged_binary = binary_path

    async def _deploy_agent_from_source(self, arch: str, *, distro: str) -> None:  # type: ignore[override]
        self.source_arch = arch
        self.source_distro = distro


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
async def test_deploy_agent_defaults_to_auto_transport():
    redis = FakeRedis()

    await deploy_agent(7, redis)

    assert redis.jobs == [("deploy_agent", {"id": 7, "recompile": False, "transport": "auto"})]


def test_resolve_agent_task_transport_uses_frame_agent_preference():
    frame = SimpleNamespace(
        agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True}
    )

    assert resolve_agent_task_transport(frame, "auto") == "agent"
    assert resolve_agent_task_transport(frame, "ssh") == "ssh"

    frame.agent["deployWithAgent"] = False
    assert resolve_agent_task_transport(frame, "auto") == "ssh"


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
    assert deployer.source_distro == "debian"
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
    monkeypatch.setattr(
        deploy_agent_module,
        "get_fresh_frame",
        lambda _db, _id: SimpleNamespace(
            id=1,
            agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        ),
    )
    monkeypatch.setattr(AgentDeployer, "run", fake_run)

    await deploy_agent_task({"db": object(), "redis": object()}, id=1, recompile=True)

    assert captured == {"ran": True, "force_source": True, "transport": "agent"}


@pytest.mark.asyncio
async def test_deploy_agent_task_keeps_explicit_ssh_transport(
    monkeypatch: pytest.MonkeyPatch,
):
    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    captured: dict[str, object] = {}

    async def fake_run(self):
        captured["transport"] = self.remote_transport

    monkeypatch.setattr(
        deploy_agent_module,
        "get_fresh_frame",
        lambda _db, _id: SimpleNamespace(
            id=1,
            agent={"agentEnabled": True, "agentRunCommands": True, "deployWithAgent": True},
        ),
    )
    monkeypatch.setattr(AgentDeployer, "run", fake_run)

    await deploy_agent_task({"db": object(), "redis": object()}, id=1, transport="ssh")

    assert captured == {"transport": "ssh"}


@pytest.mark.asyncio
async def test_deploy_agent_falls_back_to_source_for_unsupported_target(tmp_path: Path):
    deployer = FakeAgentDeployer(tmp_path)

    await deployer._deploy_agent(arch="mips64", distro="debian", distro_version="trixie")

    assert deployer.staged_binary is None
    assert deployer.source_arch == "mips64"
    assert deployer.source_distro == "debian"


@pytest.mark.asyncio
async def test_agent_source_build_installs_ubuntu_compiler_dependencies(tmp_path: Path):
    deployer = FakeAgentDeployer(tmp_path)
    deployer.remote_transport = "agent"
    deployer.command_statuses = [
        ("dpkg-query -W -f='${Status}' build-essential", 1),
        ("dpkg-query -W -f='${Status}' libssl-dev", 1),
    ]

    await deployer._ensure_agent_source_build_dependencies("ubuntu")

    install_commands = [command for command in deployer.commands if "apt-get install -y" in command]
    assert len(install_commands) == 1
    assert "systemd-run" in install_commands[0]
    assert "build-essential" in install_commands[0]
    assert "libssl-dev" in install_commands[0]
    assert any("command -v gcc" in command for command in deployer.commands)
    assert any("/usr/include/openssl/ssl.h" in command for command in deployer.commands)


@pytest.mark.asyncio
async def test_agent_source_build_requires_gcc_on_buildroot(tmp_path: Path):
    deployer = FakeAgentDeployer(tmp_path)
    deployer.command_statuses = [("command -v gcc", 1)]

    with pytest.raises(RuntimeError, match="Cannot source-build the FrameOS agent on buildroot"):
        await deployer._ensure_agent_source_build_dependencies("buildroot")
