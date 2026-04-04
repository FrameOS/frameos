from pathlib import Path

import pytest

from app.tasks.prebuilt_deps import PrebuiltEntry
from app.utils import prebuilt_component


def _write_lgpio_tree(root: Path) -> None:
    (root / "include").mkdir(parents=True, exist_ok=True)
    (root / "lib").mkdir(parents=True, exist_ok=True)
    (root / "include" / "lgpio.h").write_text("/* lgpio */\n", encoding="utf-8")
    (root / "lib" / "liblgpio.a").write_bytes(b"ar")


@pytest.mark.asyncio
async def test_stage_prebuilt_component_from_manifest_downloads_matching_lgpio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"lgpio": "v0.2.2"},
        component_urls={"lgpio": "https://archive.frameos.net/prebuilt-deps/debian-bookworm-arm64/lgpio-v0.2.2.tar.gz"},
        component_md5s={"lgpio": "abc123"},
    )
    dest_dir = tmp_path / "lgpio-v0.2.2"

    async def fake_fetch_prebuilt_manifest(*, base_url: str | None = None):
        assert base_url is None
        return {entry.target: entry}

    async def fake_download_and_extract(
        url: str,
        extracted_dir: Path,
        expected_md5: str | None,
        *,
        timeout: float,
    ) -> None:
        assert url == entry.component_urls["lgpio"]
        assert expected_md5 == "abc123"
        assert timeout == prebuilt_component.PREBUILT_TIMEOUT
        _write_lgpio_tree(extracted_dir)

    monkeypatch.setattr(prebuilt_component, "fetch_prebuilt_manifest", fake_fetch_prebuilt_manifest)
    monkeypatch.setattr(prebuilt_component, "_download_and_extract", fake_download_and_extract)

    result = await prebuilt_component.stage_prebuilt_component_from_manifest(
        target=entry.target,
        component="lgpio",
        version="v0.2.2",
        dest_dir=dest_dir,
        expected_marker="marker-data",
    )

    assert result is True
    assert (dest_dir / "include" / "lgpio.h").read_text(encoding="utf-8") == "/* lgpio */\n"
    assert (dest_dir / "lib" / "liblgpio.a").read_bytes() == b"ar"
    assert (dest_dir / ".build-info").read_text(encoding="utf-8") == "marker-data"


@pytest.mark.asyncio
async def test_stage_prebuilt_component_copies_local_component_tree(tmp_path: Path) -> None:
    local_component = tmp_path / "local-lgpio"
    _write_lgpio_tree(local_component)
    dest_dir = tmp_path / "staged-lgpio"
    entry = PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"lgpio": "local"},
        component_urls={},
        component_md5s={},
        component_paths={"lgpio": str(local_component)},
    )

    result = await prebuilt_component.stage_prebuilt_component(
        entry,
        component="lgpio",
        version="local",
        dest_dir=dest_dir,
        expected_marker="local-marker",
    )

    assert result is True
    assert dest_dir != local_component
    assert (dest_dir / "include" / "lgpio.h").read_text(encoding="utf-8") == "/* lgpio */\n"
    assert (dest_dir / "lib" / "liblgpio.a").read_bytes() == b"ar"
    assert (dest_dir / ".build-info").read_text(encoding="utf-8") == "local-marker"


@pytest.mark.asyncio
async def test_stage_prebuilt_component_cleans_invalid_partial_extract(tmp_path: Path) -> None:
    broken_component = tmp_path / "broken-lgpio"
    (broken_component / "include").mkdir(parents=True, exist_ok=True)
    (broken_component / "include" / "lgpio.h").write_text("/* lgpio */\n", encoding="utf-8")
    dest_dir = tmp_path / "staged-lgpio"
    entry = PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"lgpio": "v0.2.2"},
        component_urls={},
        component_md5s={},
        component_paths={"lgpio": str(broken_component)},
    )

    result = await prebuilt_component.stage_prebuilt_component(
        entry,
        component="lgpio",
        version="v0.2.2",
        dest_dir=dest_dir,
        expected_marker="broken-marker",
    )

    assert result is False
    assert not dest_dir.exists()
