from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry, resolve_prebuilt_target
from app.utils.cross_compile import CrossCompiler, TargetMetadata


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

    if component == "lgpio":
        (dest_dir / "include").mkdir(parents=True, exist_ok=True)
        (dest_dir / "lib").mkdir(parents=True, exist_ok=True)
        if valid:
            (dest_dir / "include" / "lgpio.h").write_text("// lgpio\n")
            (dest_dir / "lib" / "liblgpio.a").write_bytes(b"!<arch>\n")
        return

    raise AssertionError(f"Unexpected component: {component}")


def test_resolve_prebuilt_target_maps_raspios_bullseye_arm64():
    assert resolve_prebuilt_target("raspios", "bullseye", "aarch64") == "debian-bullseye-arm64"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("component", "version"),
    [
        ("quickjs", "2025-04-26"),
        ("lgpio", "v0.2.2"),
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
    compiler = make_cross_compiler(tmp_path, monkeypatch, component="quickjs", version="2025-04-26")
    dest_dir = compiler.prebuilt_dir / "quickjs-2025-04-26"

    async def fake_download(_url: str, extract_dir, _expected_md5: str | None) -> None:
        write_component_payload("quickjs", extract_dir, valid=False)

    monkeypatch.setattr(compiler, "_download_and_extract", fake_download)

    result = await compiler._ensure_prebuilt_component("quickjs")

    assert result is None
    assert dest_dir.exists() is False


@pytest.mark.asyncio
async def test_ensure_lgpio_builds_from_source_without_prebuilt_sysroot(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache"))
    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=SimpleNamespace(build_id="build12345678"),
        target=TargetMetadata(arch="aarch64", distro="raspios", version="bullseye"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=None,
    )

    await compiler._ensure_lgpio_in_sysroot()

    assert compiler._build_lgpio_from_source is True
    assert "Building lgpio v0.2.2 from source" in compiler._build_lgpio_source_script()


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

    async def fake_exec_local_command(_db, _redis, _frame, _cmd, **_kwargs):
        captured_script["content"] = (temp_dir / "frameos-cross-build.sh").read_text()
        return 0, "", ""

    monkeypatch.setattr(compiler, "_ensure_toolchain_image", fake_ensure_toolchain_image)
    monkeypatch.setattr("app.utils.cross_compile.exec_local_command", fake_exec_local_command)

    result = await compiler._run_docker_build(str(build_dir))

    script = captured_script["content"]
    assert result == str(build_dir / "frameos")
    assert "Rebuilding QuickJS archive for target" in script
    assert "make -C quickjs clean" in script
    assert "make -C quickjs libquickjs.a" in script
    assert script.index("make -C quickjs libquickjs.a") < script.index("make -j\"$make_jobs\"")
