from pathlib import Path

import pytest

from app.utils.build_executor import DockerMount, ModalBuildExecutor
from app.utils.modal_sandbox import ModalSandboxConfig


@pytest.mark.asyncio
async def test_modal_executor_routes_docker_run_through_direct_image(monkeypatch, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    calls = []

    class FakeModalSandboxSession:
        def __init__(self, config, logger=None):
            self.config = config
            self.logger = logger
            calls.append(("init", config))

        async def __aenter__(self):
            calls.append(("enter",))
            return self

        async def __aexit__(self, exc_type, exc, tb):
            calls.append(("exit", exc_type))
            return None

        async def sync_dir_tarball(self, local_path, remote_path):
            calls.append(("sync_dir", Path(local_path), remote_path))

        async def sync_dir_archive(self, archive_path, remote_path):
            calls.append(("sync_archive", Path(archive_path), remote_path))

        async def sync_file(self, local_path, remote_path):
            calls.append(("sync_file", Path(local_path), remote_path))

        async def download_dir_tarball(self, remote_path, local_path):
            calls.append(("download_dir", remote_path, Path(local_path)))

        async def download_file(self, remote_path, local_path):
            calls.append(("download_file", remote_path, Path(local_path)))

        async def run(self, command, **kwargs):
            calls.append(("run", command, kwargs))
            return 0, "ok\n", None

    monkeypatch.setattr("app.utils.build_executor.ModalSandboxSession", FakeModalSandboxSession)

    executor = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
            enable_docker=True,
        )
    )

    status, out, err = await executor.run(
        f"docker run --rm -v {work}:/work -w /work example/image:latest bash build.sh",
        log_command=False,
        log_output=False,
    )

    assert (status, out, err) == (0, "ok\n", None)
    assert calls[0][0] == "init"
    config = calls[0][1]
    assert config.image == "example/image:latest"
    assert config.enable_docker is False
    assert config.cpu == 2
    assert config.memory == 4096
    sync_archive_calls = [call for call in calls if call[0] == "sync_archive"]
    assert len(sync_archive_calls) == 1
    assert sync_archive_calls[0][1].suffixes[-2:] == [".tar", ".gz"]
    assert sync_archive_calls[0][2] == "/work"
    assert (
        "run",
        "cd /work && bash build.sh",
        {"log_command": False, "log_output": False},
    ) in calls
    assert ("download_dir", "/work", work) in calls


def test_modal_executor_uses_plain_tag_for_direct_container_images():
    executor = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
        )
    )

    image = "frameos/frameos-cross-toolchain:debian_bookworm-linux_arm64-latest"
    resolved = f"{image}@sha256:17e810a39fb457429852a63587d39a7dcdee436771d02c50254b4f98976c1e38"

    assert executor.container_image_reference(image, resolved) == image


@pytest.mark.asyncio
async def test_modal_executor_rejects_non_amd64_direct_container_platform(monkeypatch):
    calls = []

    class FakeModalSandboxSession:
        def __init__(self, config, logger=None):
            self.config = config
            self.logger = logger
            calls.append(("init", config))

        async def __aenter__(self):
            calls.append(("enter",))
            return self

        async def __aexit__(self, exc_type, exc, tb):
            calls.append(("exit", exc_type))
            return None

    monkeypatch.setattr("app.utils.build_executor.ModalSandboxSession", FakeModalSandboxSession)

    logs = []

    async def logger(level, message):
        logs.append((level, message))

    executor = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
            enable_docker=False,
        ),
        logger=logger,
    )

    status, out, err = await executor.docker_run(
        image="frameos/frameos-cross-toolchain:debian_bookworm-linux_arm64-latest",
        platform="linux/arm64",
        mounts=[],
        workdir="/src",
        args=["bash", "build.sh"],
        log_command=False,
        log_output=False,
    )

    assert status == 125
    assert out is None
    assert err is not None
    assert "linux/amd64 registry images" in err
    assert calls == []
    assert logs == [("stderr", err.strip())]


def test_modal_executor_maps_non_amd64_targets_to_amd64_container_platform():
    executor = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
        )
    )

    assert executor.container_platform_for_target("linux/arm64") == "linux/amd64"
    assert executor.container_platform_for_target("linux/amd64") == "linux/amd64"


def test_modal_executor_resource_profiles_respect_user_overrides():
    executor = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
        )
    )

    cross_compile = executor._config_with_resources(image="toolchain", workspace="cross-compile")
    compose = executor._config_with_resources(image="buildroot", workspace="compose")

    assert (cross_compile.cpu, cross_compile.memory) == (8, 16384)
    assert (compose.cpu, compose.memory) == (4, 8192)

    overridden = ModalBuildExecutor(
        ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:base",
            cpu=6,
            memory=12288,
        )
    )._config_with_resources(image="toolchain", workspace="cross-compile")

    assert (overridden.cpu, overridden.memory) == (6, 12288)
