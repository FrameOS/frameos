from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry
from app.utils.cross_compile import CrossCompiler, TargetMetadata


class FakeDeployer:
    build_id = "build12345678"


def build_compiler(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    prebuilt_entry: PrebuiltEntry | None = None,
):
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", str(tmp_path / "cache"))
    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    compiler = CrossCompiler(
        db=None,
        redis=None,
        frame=SimpleNamespace(id=1),
        deployer=FakeDeployer(),
        target=TargetMetadata(arch="arm64", distro="debian", version="bookworm"),
        temp_dir=str(tmp_path / "tmp"),
        prebuilt_entry=prebuilt_entry,
        prebuilt_target="debian-bookworm-arm64",
        logger=logger,
    )
    return compiler, logs


@pytest.mark.asyncio
async def test_ensure_prebuilt_component_redownloads_invalid_cached_quickjs(tmp_path, monkeypatch: pytest.MonkeyPatch):
    prebuilt_entry = PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"quickjs": "2025-04-26"},
        component_urls={"quickjs": "https://example.invalid/quickjs.tar.gz"},
        component_md5s={"quickjs": "abc123"},
    )
    compiler, logs = build_compiler(tmp_path, monkeypatch, prebuilt_entry=prebuilt_entry)

    dest_dir = compiler.prebuilt_dir / "quickjs-2025-04-26"
    (dest_dir / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
    (dest_dir / "lib").mkdir(parents=True, exist_ok=True)
    expected_marker = "quickjs|2025-04-26|https://example.invalid/quickjs.tar.gz|abc123"
    (dest_dir / ".build-info").write_text(expected_marker)

    download_calls: list[tuple[str, str | None]] = []

    async def fake_download(url: str, extract_dir, expected_md5: str | None) -> None:
        download_calls.append((url, expected_md5))
        (extract_dir / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
        (extract_dir / "lib").mkdir(parents=True, exist_ok=True)
        (extract_dir / "include" / "quickjs" / "quickjs.h").write_text("header")
        (extract_dir / "include" / "quickjs" / "quickjs-libc.h").write_text("libc header")
        (extract_dir / "lib" / "libquickjs.a").write_text("archive")

    monkeypatch.setattr(compiler, "_download_and_extract", fake_download)

    result = await compiler._ensure_prebuilt_component("quickjs")

    assert result == dest_dir
    assert download_calls == [("https://example.invalid/quickjs.tar.gz", "abc123")]
    assert (dest_dir / "include" / "quickjs" / "quickjs.h").exists()
    assert (dest_dir / "include" / "quickjs" / "quickjs-libc.h").exists()
    assert (dest_dir / "lib" / "libquickjs.a").exists()
    assert any("Cached prebuilt quickjs" in message and "incomplete" in message for _, message in logs)


@pytest.mark.asyncio
async def test_ensure_quickjs_tree_keeps_existing_sources_when_prebuilt_is_incomplete(tmp_path, monkeypatch: pytest.MonkeyPatch):
    compiler, _logs = build_compiler(tmp_path, monkeypatch)
    dest = tmp_path / "frameos" / "quickjs"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "quickjs.h").write_text("vendored header")
    (dest / "quickjs-libc.h").write_text("vendored libc header")
    (dest / "libquickjs.a").write_text("vendored archive")

    bad_prebuilt = tmp_path / "bad-prebuilt"
    (bad_prebuilt / "include" / "quickjs").mkdir(parents=True, exist_ok=True)
    (bad_prebuilt / "lib").mkdir(parents=True, exist_ok=True)
    compiler.prebuilt_components["quickjs"] = bad_prebuilt

    await compiler._ensure_quickjs_tree(
        dest,
        context="source directory",
        fallback_src=None,
        error_message="QuickJS sources are missing",
    )

    assert (dest / "quickjs.h").read_text() == "vendored header"
    assert (dest / "quickjs-libc.h").read_text() == "vendored libc header"
    assert (dest / "libquickjs.a").read_text() == "vendored archive"
