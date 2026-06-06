from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry, resolve_prebuilt_target
from app.utils.build_executor import create_build_executor
from app.utils.cross_compile import CrossCompiler, TargetMetadata
from app.utils.modal_sandbox import ModalSandboxConfig


def make_cross_compiler(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    component: str,
    version: str,
) -> CrossCompiler:
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    return CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bookworm"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=PrebuiltEntry(
            target="debian-bookworm-arm64",
            versions={component: version},
            component_urls={component: f"https://example.invalid/{component}-{version}.tar.gz"},
            component_md5s={component: "deadbeef"},
        ),
    )


def write_component_payload(component: str, dest_dir, *, valid: bool) -> None:
    if component == "quickjs":
        (dest_dir / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
        (dest_dir / "lib").mkdir(parents=True, exist_ok=True)
        if valid:
            (dest_dir / "include" / "quickjs" / "quickjs.h").write_text("// quickjs\n")
            (dest_dir / "include" / "quickjs" / "quickjs-libc.h").write_text("// quickjs libc\n")
            (dest_dir / "lib" / "libquickjs.a").write_bytes(b"!<arch>\n")
        return

    raise AssertionError(f"Unexpected component: {component}")


def test_resolve_prebuilt_target_maps_raspios_bullseye_arm64():
    assert resolve_prebuilt_target("raspios", "bullseye", "aarch64") == "debian-bullseye-arm64"


def test_resolve_prebuilt_target_maps_ubuntu_26_04_arm64():
    assert resolve_prebuilt_target("ubuntu", "26.04", "aarch64") == "ubuntu-26.04-arm64"


def test_cross_compiler_uses_buildroot_toolchain_base_for_buildroot_release(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="buildroot", version="2025.02.13"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
    )

    assert compiler._docker_image() == "ubuntu:22.04"
    assert compiler._toolchain_image() == "frameos/frameos-cross-toolchain:ubuntu_22.04-linux_arm64-latest"


def test_cross_compiler_falls_back_from_invalid_detected_release(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="ubuntu", version="2025.02.13"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
    )

    assert compiler._docker_image() == "ubuntu:26.04"


def test_cross_compiler_canonicalizes_ubuntu_codename(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="ubuntu", version="noble"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
    )

    assert compiler._docker_image() == "ubuntu:24.04"


def test_cross_compiler_bakes_target_cross_packages_into_amd64_toolchain_image(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bookworm"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
    )

    dpkg_archs, packages = compiler._target_cross_toolchain_build_args("linux/amd64")

    assert dpkg_archs == "arm64 armhf"
    assert "gcc-aarch64-linux-gnu" in packages
    assert "libssl-dev:arm64" in packages
    assert "gcc-arm-linux-gnueabihf" in packages
    assert "libssl-dev:armhf" in packages
    assert compiler._target_cross_toolchain_build_args("linux/arm64") == ("", "")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("component", "version"),
    [
        ("quickjs", "2026-06-04"),
    ],
)
async def test_ensure_prebuilt_component_refreshes_incomplete_cached_artifacts(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    component: str,
    version: str,
):
    compiler = make_cross_compiler(tmp_path, monkeypatch, component=component, version=version)
    dest_dir = compiler.prebuilt_dir / f"{component}-{version}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / ".build-info").write_text(
        f"{component}|{version}|https://example.invalid/{component}-{version}.tar.gz|deadbeef"
    )
    write_component_payload(component, dest_dir, valid=False)

    download_count = 0

    async def fake_download(_url: str, extract_dir, _expected_md5: str | None) -> None:
        nonlocal download_count
        download_count += 1
        write_component_payload(component, extract_dir, valid=True)

    monkeypatch.setattr(compiler, "_download_and_extract", fake_download)

    result = await compiler._ensure_prebuilt_component(component)

    assert result == dest_dir
    assert download_count == 1
    assert compiler._prebuilt_component_is_valid(component, dest_dir) is True


@pytest.mark.asyncio
async def test_ensure_prebuilt_component_rejects_invalid_download(tmp_path, monkeypatch: pytest.MonkeyPatch):
    compiler = make_cross_compiler(tmp_path, monkeypatch, component="quickjs", version="2026-06-04")
    dest_dir = compiler.prebuilt_dir / "quickjs-2026-06-04"

    async def fake_download(_url: str, extract_dir, _expected_md5: str | None) -> None:
        write_component_payload("quickjs", extract_dir, valid=False)

    monkeypatch.setattr(compiler, "_download_and_extract", fake_download)

    result = await compiler._ensure_prebuilt_component("quickjs")

    assert result is None
    assert dest_dir.exists() is False


@pytest.mark.asyncio
async def test_run_docker_build_prepares_quickjs_archive_before_linking(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    temp_dir = tmp_path / "tmp"
    build_dir = tmp_path / "build"
    temp_dir.mkdir()
    build_dir.mkdir()
    captured_script: dict[str, str] = {}

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bullseye"),
        temp_dir=str(temp_dir),
        prebuilt_entry=None,
    )

    async def fake_ensure_toolchain_image() -> str:
        return "frameos-cross-test"

    async def fake_docker_run(**_kwargs):
        captured_script["content"] = (temp_dir / "frameos-cross-build.sh").read_text()
        return 0, "", ""

    monkeypatch.setattr(compiler, "_ensure_toolchain_image", fake_ensure_toolchain_image)
    compiler.executor = SimpleNamespace(docker_run=fake_docker_run)

    result = await compiler._run_docker_build(str(build_dir))

    script = captured_script["content"]
    assert result == str(build_dir / "frameos")
    assert "make -C quickjs clean" in script
    assert "make -C quickjs libquickjs.a" in script
    assert "Rebuilding QuickJS archive for target" not in script
    assert "Indexing QuickJS archive" not in script
    assert script.index("make -C quickjs libquickjs.a") < script.index("make -j\"$make_jobs\"")


@pytest.mark.asyncio
async def test_quickjs_preparation_is_quiet_on_success(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bookworm"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
        logger=logger,
    )
    prebuilt_dir = tmp_path / "prebuilt" / "quickjs-2026-06-04"
    source_dir = tmp_path / "source"
    build_dir = tmp_path / "build"
    prebuilt_dir.mkdir(parents=True)
    source_dir.mkdir()
    build_dir.mkdir()
    write_component_payload("quickjs", prebuilt_dir, valid=True)
    compiler.prebuilt_components["quickjs"] = prebuilt_dir

    await compiler._ensure_quickjs_sources(str(source_dir))
    await compiler._ensure_quickjs_in_build_dir(str(source_dir), build_dir)

    assert logs == []
    assert (source_dir / "quickjs" / "libquickjs.a").exists()
    assert (build_dir / "quickjs" / "libquickjs.a").exists()


@pytest.mark.asyncio
async def test_modal_toolchain_build_uses_amd64_image_with_target_cross_compiler(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    temp_dir = tmp_path / "tmp"
    build_dir = tmp_path / "build"
    temp_dir.mkdir()
    build_dir.mkdir()
    calls: list[tuple[str, str]] = []
    synced_scripts: list[str] = []

    class FakeModalSandboxSession:
        def __init__(self, config, *, logger=None):
            self.config = config
            self.logger = logger

        async def __aenter__(self):
            calls.append(("image", self.config.image))
            calls.append(("resources", f"{self.config.cpu}:{self.config.memory}"))
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def mktemp_dir(self, prefix: str = "frameos-cross-") -> str:
            return "/tmp/frameos-cross-test"

        async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
            calls.append(("sync", f"{local_path}->{remote_path}"))

        async def sync_dir_archive(self, archive_path: str, remote_path: str) -> None:
            calls.append(("sync-archive", f"{archive_path}->{remote_path}"))

        async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
            calls.append(("write", remote_path))

        async def sync_file(self, local_path: str, remote_path: str) -> None:
            calls.append(("sync-file", f"{local_path}->{remote_path}"))
            if remote_path.endswith("/build.sh"):
                synced_scripts.append(Path(local_path).read_text())

        async def run(self, command: str, **kwargs):
            calls.append(("run", command))
            if "find drivers scenes" in command:
                return 0, "", ""
            return 0, "", ""

        async def download_file(self, remote_path: str, local_path: str) -> None:
            calls.append(("download", f"{remote_path}->{local_path}"))
            Path(local_path).write_text("binary")

        async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
            calls.append(("download-dir", f"{remote_path}->{local_path}"))
            Path(local_path).mkdir(parents=True, exist_ok=True)
            (Path(local_path) / "frameos").write_text("binary")

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bookworm"),
        temp_dir=str(temp_dir),
        prebuilt_entry=None,
        build_host=ModalSandboxConfig(
            enabled=True,
            token_id="ak-test",
            token_secret="as-test",
            image="frameos/frameos:latest",
        ),
    )

    monkeypatch.setattr("app.utils.build_executor.ModalSandboxSession", FakeModalSandboxSession)
    compiler.executor = create_build_executor(
        compiler.build_host,
        db=None,
        redis=None,
        frame=compiler.frame,
        logger=None,
    )

    result = await compiler._run_docker_build(str(build_dir))

    assert result == str(build_dir / "frameos")
    image_calls = [value for kind, value in calls if kind == "image"]
    assert image_calls == ["frameos/frameos-cross-toolchain:debian_bookworm-linux_amd64-latest"]
    assert ("resources", "8.0:16384") in calls
    run_commands = [value for kind, value in calls if kind == "run"]
    assert any(
        "bash /tmp/frameos-cross/build.sh" in command
        for command in run_commands
    )
    assert len(synced_scripts) == 1
    assert "apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu" in synced_scripts[0]
    assert "export CC=aarch64-linux-gnu-gcc" in synced_scripts[0]
