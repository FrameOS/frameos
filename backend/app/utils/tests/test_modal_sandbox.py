from pathlib import Path

import pytest

from app.utils.modal_sandbox import (
    FRAMEOS_SANDBOX_PATH,
    ModalSandboxConfig,
    ModalSandboxSession,
    parse_docker_run_command,
    sandbox_sync_paths_for_command,
)


def test_modal_sandbox_config_requires_credentials():
    assert ModalSandboxConfig.from_settings({"enabled": True, "tokenId": "ak-test"}) is None
    assert ModalSandboxConfig.from_settings({"enabled": False, "tokenId": "ak-test", "tokenSecret": "as-test"}) is None


def test_modal_sandbox_config_parses_settings():
    config = ModalSandboxConfig.from_settings(
        {
            "enabled": True,
            "tokenId": "ak-test",
            "tokenSecret": "as-test",
            "appName": "frameos-custom",
            "image": "frameos/frameos:custom",
            "timeout": "120",
            "idleTimeout": "30",
            "cpu": "4",
            "memory": "8192",
            "enableDocker": False,
        }
    )

    assert isinstance(config, ModalSandboxConfig)
    assert config.app_name == "frameos-custom"
    assert config.image == "frameos/frameos:custom"
    assert config.timeout == 120
    assert config.idle_timeout == 30
    assert config.cpu == 4
    assert config.memory == 8192
    assert config.enable_docker is False


def test_modal_sandbox_connection_summary_includes_resource_details():
    session = ModalSandboxSession(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            app_name="frameos-custom",
            image="frameos/frameos:custom",
            timeout=120,
            idle_timeout=30,
            cpu=4,
            memory=8192,
            region="us-east",
            cloud="aws",
            environment_name="prod",
            enable_docker=False,
        )
    )

    summary = session._connection_summary({"host": "modal-host", "cpu_count": "8", "memory_mib": "16384"})

    assert "Connected to Modal sandbox" in summary
    assert "app=frameos-custom" in summary
    assert "environment=prod" in summary
    assert "host=modal-host" in summary
    assert "image=frameos/frameos:custom" in summary
    assert "cpu=4 requested" in summary
    assert "memory=8192 MiB requested" in summary
    assert "region=us-east" in summary
    assert "cloud=aws" in summary
    assert "timeout=120s" in summary
    assert "idle_timeout=30s" in summary
    assert "nested_docker=disabled" in summary


def test_sandbox_sync_paths_for_docker_mounts(tmp_path):
    src = tmp_path / "src"
    cache = tmp_path / "cache"
    src.mkdir()
    cache.mkdir()

    command = f"docker run --rm -v {src}:/src -v {cache}:/cache image sh -lc 'echo ok'"
    paths = sandbox_sync_paths_for_command(command)

    assert tmp_path in paths


def test_sandbox_sync_paths_preserves_command_path_spelling(tmp_path):
    real_root = tmp_path / "private" / "var" / "folders" / "frameos-build"
    real_root.mkdir(parents=True)
    alias_root = tmp_path / "var"
    alias_root.symlink_to(tmp_path / "private" / "var")
    command_path = alias_root / "folders" / "frameos-build"

    command = f"cd {command_path} && nimble setup"
    paths = sandbox_sync_paths_for_command(command)

    assert command_path in paths
    assert real_root.resolve() not in paths


def test_parse_docker_run_command_extracts_modal_sandbox_shape(tmp_path):
    work = tmp_path / "work"
    cache = tmp_path / "cache"
    command = (
        f"docker run --rm --platform linux/arm64 -v {work}:/work -v {cache}:/cache:ro "
        "-e FORCE_UNSAFE_CONFIGURE=1 -w /work frameos/frameos-buildroot:latest bash /work/build.sh"
    )

    spec = parse_docker_run_command(command)

    assert spec is not None
    assert spec.image == "frameos/frameos-buildroot:latest"
    assert spec.platform == "linux/arm64"
    assert spec.workdir == "/work"
    assert spec.env == {"FORCE_UNSAFE_CONFIGURE": "1"}
    assert [(mount.source, mount.target, mount.read_only) for mount in spec.mounts] == [
        (work, "/work", False),
        (cache, "/cache", True),
    ]
    assert spec.args == ["bash", "/work/build.sh"]


@pytest.mark.asyncio
async def test_modal_sandbox_run_exports_frameos_path(monkeypatch):
    calls = []

    class FakeStream:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class FakeProcess:
        stdout = FakeStream()
        stderr = FakeStream()

        def wait(self):
            return 0

    class FakeSandbox:
        def exec(self, *args, **kwargs):
            calls.append((args, kwargs))
            return FakeProcess()

    session = ModalSandboxSession(
        ModalSandboxConfig(enabled=True, token_id="ak-test", token_secret="as-test"),
    )
    session._sandbox = FakeSandbox()

    status, _out, _err = await session.run("nimble --version", log_command=False)

    assert status == 0
    args, kwargs = calls[0]
    assert args[:2] == ("bash", "-lc")
    assert f"export PATH={FRAMEOS_SANDBOX_PATH}" in args[2]
    assert args[2].endswith("; nimble --version")
    assert kwargs["timeout"] == session.config.timeout
