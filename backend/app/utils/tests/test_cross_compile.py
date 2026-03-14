from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry
from app.utils.cross_compile import CrossCompileArtifacts, CrossCompiler, TargetMetadata


async def _noop_logger(_level: str, _message: str) -> None:
    return None


def _make_compiler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    prebuilt_entry: PrebuiltEntry | None,
) -> CrossCompiler:
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cache"))
    return CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build123"),
        target=TargetMetadata(arch="aarch64", distro="debian", version="bookworm"),
        temp_dir=str(tmp_path / "work"),
        prebuilt_entry=prebuilt_entry,
        prebuilt_target="debian-bookworm-arm64",
        logger=_noop_logger,
    )


def _write_quickjs_tree(root: Path) -> None:
    (root / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
    (root / "include" / "quickjs" / "quickjs.h").write_text("/* quickjs */\n", encoding="utf-8")
    (root / "include" / "quickjs" / "quickjs-libc.h").write_text("/* quickjs-libc */\n", encoding="utf-8")
    (root / "lib").mkdir(parents=True, exist_ok=True)
    (root / "lib" / "libquickjs.a").write_bytes(b"ar")


def _write_local_quickjs_tree(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "quickjs.h").write_text("/* local quickjs */\n", encoding="utf-8")
    (root / "quickjs-libc.h").write_text("/* local quickjs-libc */\n", encoding="utf-8")
    (root / "libquickjs.a").write_bytes(b"local-ar")


@pytest.mark.asyncio
async def test_ensure_prebuilt_component_refreshes_incomplete_quickjs_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    prebuilt_entry = PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"quickjs": "2025-04-26"},
        component_urls={"quickjs": "https://archive.frameos.net/prebuilt-deps/debian-bookworm-arm64/quickjs-2025-04-26.tar.gz"},
        component_md5s={"quickjs": "abc123"},
    )
    compiler = _make_compiler(tmp_path, monkeypatch, prebuilt_entry=prebuilt_entry)
    dest_dir = compiler.prebuilt_dir / "quickjs-2025-04-26"
    (dest_dir / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
    (dest_dir / "lib").mkdir(parents=True, exist_ok=True)
    (dest_dir / ".build-info").write_text(
        "quickjs|2025-04-26|https://archive.frameos.net/prebuilt-deps/debian-bookworm-arm64/quickjs-2025-04-26.tar.gz|abc123",
        encoding="utf-8",
    )

    download_calls = 0

    async def fake_download(_url: str, extracted_dir: Path, _expected_md5: str | None) -> None:
        nonlocal download_calls
        download_calls += 1
        _write_quickjs_tree(extracted_dir)

    monkeypatch.setattr(compiler, "_download_and_extract", fake_download)

    result = await compiler._ensure_prebuilt_component("quickjs")

    assert result == dest_dir
    assert download_calls == 1
    assert (dest_dir / "include" / "quickjs" / "quickjs.h").is_file()
    assert (dest_dir / "include" / "quickjs" / "quickjs-libc.h").is_file()
    assert (dest_dir / "lib" / "libquickjs.a").is_file()


@pytest.mark.asyncio
async def test_ensure_quickjs_sources_keeps_existing_local_tree_when_prebuilt_is_invalid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    compiler = _make_compiler(tmp_path, monkeypatch, prebuilt_entry=None)
    invalid_prebuilt = tmp_path / "invalid-prebuilt"
    (invalid_prebuilt / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
    (invalid_prebuilt / "lib").mkdir(parents=True, exist_ok=True)
    compiler.prebuilt_components["quickjs"] = invalid_prebuilt

    source_dir = tmp_path / "source"
    quickjs_root = source_dir / "quickjs"
    _write_local_quickjs_tree(quickjs_root)

    await compiler._ensure_quickjs_sources(str(source_dir))

    assert (quickjs_root / "quickjs.h").read_text(encoding="utf-8") == "/* local quickjs */\n"
    assert (quickjs_root / "quickjs-libc.h").read_text(encoding="utf-8") == "/* local quickjs-libc */\n"
    assert (quickjs_root / "libquickjs.a").read_bytes() == b"local-ar"


@pytest.mark.asyncio
async def test_run_remote_docker_build_downloads_compiled_scene_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    compiler = _make_compiler(tmp_path, monkeypatch, prebuilt_entry=None)
    build_dir = tmp_path / "build"
    build_dir.mkdir(parents=True, exist_ok=True)

    class FakeBuildHostSession:
        def __init__(self) -> None:
            self.commands: list[str] = []
            self.downloaded_binary: tuple[str, str] | None = None
            self.downloaded_scenes: tuple[str, str] | None = None
            self.synced_dirs: list[tuple[str, str]] = []
            self.written_files: list[tuple[str, str, int]] = []

        async def sync_dir_tarball(self, local_path: str, remote_path: str) -> None:
            self.synced_dirs.append((local_path, remote_path))

        async def write_file(self, remote_path: str, content: str, mode: int = 0o644) -> None:
            self.written_files.append((remote_path, content, mode))

        async def run(self, command: str, **_kwargs):
            self.commands.append(command)
            if command.startswith("test -d "):
                return 0, None, None
            return 0, None, None

        async def download_file(self, remote_path: str, local_path: str) -> None:
            self.downloaded_binary = (remote_path, local_path)
            Path(local_path).write_bytes(b"frameos")

        async def download_dir_tarball(self, remote_path: str, local_path: str) -> None:
            self.downloaded_scenes = (remote_path, local_path)
            local_dir = Path(local_path)
            local_dir.mkdir(parents=True, exist_ok=True)
            (local_dir / "demo.so").write_bytes(b"plugin")

    fake_host = FakeBuildHostSession()
    compiler._build_host_session = fake_host  # type: ignore[assignment]
    compiler._remote_root = tmp_path / "remote-root"

    artifacts = await compiler._run_remote_docker_build(
        str(build_dir),
        "#!/usr/bin/env bash\nexit 0\n",
        "frameos-cross-test-image",
    )

    assert artifacts.binary_path == str(build_dir / "frameos")
    assert artifacts.scenes_dir == str(build_dir / "scenes")
    assert (build_dir / "frameos").read_bytes() == b"frameos"
    assert (build_dir / "scenes" / "demo.so").read_bytes() == b"plugin"
    assert fake_host.downloaded_binary == (
        f"{compiler._remote_root}/src/frameos",
        str(build_dir / "frameos"),
    )
    assert fake_host.downloaded_scenes == (
        f"{compiler._remote_root}/src/scenes",
        str(build_dir / "scenes"),
    )


@pytest.mark.asyncio
async def test_build_with_context_skips_quickjs_for_scene_only_cross_compile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    compiler = _make_compiler(tmp_path, monkeypatch, prebuilt_entry=None)
    source_dir = tmp_path / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    build_dir = tmp_path / "build"
    build_dir.mkdir(parents=True, exist_ok=True)
    (build_dir / "scene_builds" / "demo").mkdir(parents=True, exist_ok=True)
    compiler.build_dir_override = build_dir

    quickjs_calls: list[str] = []

    async def fake_prepare_prebuilt_components() -> None:
        return None

    async def fake_ensure_quickjs_sources(_source_dir: str) -> None:
        quickjs_calls.append("source")

    async def fake_prepare_sysroot() -> None:
        return None

    async def fake_ensure_lgpio_in_sysroot() -> None:
        return None

    async def fake_ensure_quickjs_in_build_dir(_source_dir: str, _build_dir: Path) -> None:
        quickjs_calls.append("build")

    async def fake_run_docker_build(
        build_dir_path: str,
        *,
        build_binary: bool = True,
        build_scene_ids: list[str] | None = None,
        build_scene_dirs: list[str] | None = None,
        build_all_scenes: bool = True,
    ) -> CrossCompileArtifacts:
        assert build_dir_path == str(build_dir)
        assert build_binary is False
        assert build_scene_ids == ["demo"]
        assert build_scene_dirs == ["scene_builds/demo"]
        assert build_all_scenes is False
        return CrossCompileArtifacts(binary_path=None, scenes_dir=str(build_dir / "scenes"))

    monkeypatch.setattr(compiler, "_prepare_prebuilt_components", fake_prepare_prebuilt_components)
    monkeypatch.setattr(compiler, "_ensure_quickjs_sources", fake_ensure_quickjs_sources)
    monkeypatch.setattr(compiler, "_prepare_sysroot", fake_prepare_sysroot)
    monkeypatch.setattr(compiler, "_ensure_lgpio_in_sysroot", fake_ensure_lgpio_in_sysroot)
    monkeypatch.setattr(compiler, "_ensure_quickjs_in_build_dir", fake_ensure_quickjs_in_build_dir)
    monkeypatch.setattr(compiler, "_run_docker_build", fake_run_docker_build)

    artifacts = await compiler._build_with_context(
        str(source_dir),
        build_binary=False,
        build_scene_ids=["demo"],
        build_scene_dirs=["scene_builds/demo"],
        build_all_scenes=False,
    )

    assert artifacts == CrossCompileArtifacts(binary_path=None, scenes_dir=str(build_dir / "scenes"))
    assert quickjs_calls == []
