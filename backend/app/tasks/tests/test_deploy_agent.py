from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.tasks.deploy_agent import (
    AgentDeployer,
    delayed_agent_restart_command,
    deploy_agent,
    deploy_agent_task,
    resolve_agent_task_transport,
)
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
        self.source_distro_version: str | None = None

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

    async def _deploy_agent_from_source(  # type: ignore[override]
        self,
        arch: str,
        *,
        distro: str,
        distro_version: str,
    ) -> None:
        self.source_arch = arch
        self.source_distro = distro
        self.source_distro_version = distro_version


class FakeRedis:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict]] = []

    async def enqueue_job(self, name: str, **kwargs):
        self.jobs.append((name, kwargs))


class RunFlowAgentDeployer(AgentDeployer):
    def __init__(self, tmp_path: Path, *, transport: str) -> None:
        super().__init__(
            db=None,
            redis=None,
            frame=SimpleNamespace(
                id=1,
                name="AgentFrame",
                debug=False,
                agent={"agentEnabled": True, "agentSharedSecret": "secret"},
            ),
            nim_path="",
            temp_dir=str(tmp_path),
            transport=transport,
        )
        self.events: list[str] = []
        self.logs: list[tuple[str, str]] = []
        self.wait_previous_process_signature: str | None = None

    async def log(self, type: str, line: str, timestamp=None):  # type: ignore[override]
        self.logs.append((type, line))

    async def get_cpu_architecture(self) -> str:  # type: ignore[override]
        return "aarch64"

    async def get_distro(self) -> str:  # type: ignore[override]
        return "debian"

    async def get_distro_version(self) -> str:  # type: ignore[override]
        return "bookworm"

    async def _deploy_agent(self, *, arch: str, distro: str, distro_version: str) -> None:  # type: ignore[override]
        self.events.append(f"deploy:{arch}:{distro}:{distro_version}")

    async def _setup_agent_service(self) -> None:  # type: ignore[override]
        self.events.append("setup_service")

    async def _upload_frame_json(self, path: str) -> None:  # type: ignore[override]
        self.events.append(f"upload_frame_json:{path}")

    async def _verify_staged_release(self) -> None:  # type: ignore[override]
        self.events.append("verify_staged_release")

    async def _verify_agent_transport(self, label: str) -> None:  # type: ignore[override]
        self.events.append(f"verify_transport:{label}")

    async def _switch_current_release(self) -> None:  # type: ignore[override]
        self.events.append("switch_current_release")

    async def _agent_service_process_signature(self) -> str | None:  # type: ignore[override]
        self.events.append("capture_agent_process")
        return "old-agent-process"

    async def _restart_agent_service_via_agent(self) -> None:  # type: ignore[override]
        self.events.append("restart_via_agent")

    async def restart_service(self, service_name: str) -> None:  # type: ignore[override]
        self.events.append(f"restart_service:{service_name}")

    async def _wait_for_agent_release(self, previous_process_signature: str | None = None) -> None:  # type: ignore[override]
        self.wait_previous_process_signature = previous_process_signature
        self.events.append("wait_for_agent_release")

    async def _cleanup_old_builds(self) -> None:  # type: ignore[override]
        self.events.append("cleanup_old_builds")


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


def test_delayed_agent_restart_command_uses_immediate_transient_service():
    command = delayed_agent_restart_command("build id!")

    assert "frameos-agent-restart-buildid" in command
    assert "systemd-run --quiet" in command
    assert "--on-active" not in command
    assert "/bin/sh -lc" in command
    assert "sleep 1; systemctl restart frameos_agent.service" in command


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
    assert deployer.source_distro_version == "trixie"
    assert any("requested from local development" in message for _level, message in deployer.logs)


@pytest.mark.asyncio
async def test_deploy_agent_task_does_not_require_nim_before_running_deployer(
    monkeypatch: pytest.MonkeyPatch,
):
    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    captured: dict[str, Any] = {}

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
async def test_deploy_agent_ssh_restart_waits_for_staged_release(tmp_path: Path):
    deployer = RunFlowAgentDeployer(tmp_path, transport="ssh")

    await deployer.run()

    assert "restart_service:frameos_agent" in deployer.events
    assert "wait_for_agent_release" in deployer.events
    assert deployer.wait_previous_process_signature == "old-agent-process"
    assert deployer.events.index("capture_agent_process") < deployer.events.index("switch_current_release")
    assert deployer.events.index("restart_service:frameos_agent") < deployer.events.index("wait_for_agent_release")
    assert deployer.events.index("wait_for_agent_release") < deployer.events.index("cleanup_old_builds")


@pytest.mark.asyncio
async def test_deploy_agent_agent_transport_restarts_and_waits_for_staged_release(tmp_path: Path):
    deployer = RunFlowAgentDeployer(tmp_path, transport="agent")

    await deployer.run()

    assert "restart_via_agent" in deployer.events
    assert "wait_for_agent_release" in deployer.events
    assert deployer.wait_previous_process_signature == "old-agent-process"
    assert deployer.events.index("capture_agent_process") < deployer.events.index("switch_current_release")
    assert deployer.events.index("restart_via_agent") < deployer.events.index("wait_for_agent_release")
    assert deployer.events.index("wait_for_agent_release") < deployer.events.index("cleanup_old_builds")


@pytest.mark.asyncio
async def test_wait_for_agent_release_requires_new_running_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    async def no_sleep(_seconds: float) -> None:
        return None

    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    monkeypatch.setattr(deploy_agent_module.asyncio, "sleep", no_sleep)

    deployer = FakeAgentDeployer(tmp_path)
    deployer.build_id = "newrelease"
    attempts = 0

    async def fake_exec_command(
        command: str,
        output=None,
        log_output: bool = True,
        log_command=True,
        raise_on_error: bool = True,
        timeout: int = 1800,
    ) -> int:
        nonlocal attempts
        deployer.commands.append(command)
        attempts += 1
        if attempts == 1:
            if raise_on_error:
                raise RuntimeError("old process still running")
            return 1
        if output is not None:
            output.append("restarted-agent-release-ok")
        return 0

    deployer.exec_command = fake_exec_command  # type: ignore[method-assign]

    await deployer._wait_for_agent_release("123:456")

    assert attempts == 2
    assert "123:456" in deployer.commands[0]
    assert any("Restarted agent is running the staged release" in message for _level, message in deployer.logs)


@pytest.mark.asyncio
async def test_deploy_agent_falls_back_to_source_for_unsupported_target(tmp_path: Path):
    deployer = FakeAgentDeployer(tmp_path)

    await deployer._deploy_agent(arch="mips64", distro="debian", distro_version="trixie")

    assert deployer.staged_binary is None
    assert deployer.source_arch == "mips64"
    assert deployer.source_distro == "debian"
    assert deployer.source_distro_version == "trixie"


@pytest.mark.asyncio
async def test_agent_source_build_cross_compiles_before_remote_build(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    captured: dict[str, object] = {}

    class FakeCrossCompiler:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        async def build(self, source_dir: str) -> str:
            captured["source_dir"] = source_dir
            binary_path = tmp_path / "cross-frameos-agent"
            binary_path.write_bytes(b"agent")
            return str(binary_path)

    deploy_agent_module = importlib.import_module("app.tasks.deploy_agent")
    monkeypatch.setattr(deploy_agent_module, "CrossCompiler", FakeCrossCompiler)
    monkeypatch.setattr(deploy_agent_module, "get_build_host_config", lambda _db, _project_id=None: None)

    deployer = FakeAgentDeployer(tmp_path)
    success = await deployer._try_cross_compile_agent(
        build_dir=str(tmp_path / "build"),
        source_dir=str(tmp_path / "source"),
        arch="aarch64",
        distro="ubuntu",
        distro_version="noble",
    )

    assert success is True
    assert deployer.staged_binary == str(tmp_path / "cross-frameos-agent")
    assert captured["source_dir"] == str(tmp_path / "source")
    kwargs = captured["kwargs"]
    assert kwargs["build_dir"] == str(tmp_path / "build")
    assert kwargs["output_name"] == "frameos_agent"
    assert kwargs["compile_script_name"] == "compile_frameos_agent.sh"
    assert kwargs["needs_quickjs"] is False
    assert kwargs["needs_lgpio"] is False


@pytest.mark.asyncio
async def test_agent_source_build_does_not_touch_device_when_cross_compile_succeeds(tmp_path: Path):
    calls: list[str] = []

    class CrossCompileSuccessDeployer(FakeAgentDeployer):
        def _create_agent_build_folders(self) -> tuple[str, str]:  # type: ignore[override]
            calls.append("prepare")
            build_dir = tmp_path / "build"
            source_dir = tmp_path / "source"
            build_dir.mkdir()
            source_dir.mkdir()
            return str(build_dir), str(source_dir)

        async def _create_local_build_archive(  # type: ignore[override]
            self,
            build_dir: str,
            source_dir: str,
            arch: str,
        ) -> str:
            calls.append(f"archive:{arch}:{Path(build_dir).name}:{Path(source_dir).name}")
            archive = tmp_path / "agent.tar.gz"
            archive.write_bytes(b"archive")
            return str(archive)

        async def _try_cross_compile_agent(self, **kwargs) -> bool:  # type: ignore[override]
            calls.append(f"cross:{kwargs['arch']}:{kwargs['distro']}:{kwargs['distro_version']}")
            return True

        async def _ensure_agent_source_build_dependencies(self, distro: str) -> None:  # type: ignore[override]
            raise AssertionError(f"device dependency check should not run for {distro}")

        async def _ensure_agent_directories(self) -> None:  # type: ignore[override]
            raise AssertionError("device staging should not run after cross compile succeeds")

    deployer = CrossCompileSuccessDeployer(tmp_path)

    await AgentDeployer._deploy_agent_from_source(
        deployer,
        "aarch64",
        distro="ubuntu",
        distro_version="noble",
    )

    assert calls == [
        "prepare",
        "archive:aarch64:build:source",
        "cross:aarch64:ubuntu:noble",
    ]


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
