from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry
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
):
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
