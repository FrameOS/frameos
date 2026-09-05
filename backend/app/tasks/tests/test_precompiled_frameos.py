from __future__ import annotations

import shutil
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks import precompiled_frameos
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.tasks.precompiled_frameos import download_precompiled_frameos_release, frame_compiled_scene_count


import base64
import hashlib

from cryptography.hazmat.primitives.asymmetric import ed25519

from app.tasks.tests.release_signing_helpers import signing_download as _signing_download, trust_test_key as _trust_test_key



def test_frame_compiled_scene_count_treats_missing_execution_as_interpreted():
    # Absent means interpreted since c3d5e7f9a1b2: an unstamped scene must not
    # force a source build (that is what sent HA users into Docker errors).
    frame = SimpleNamespace(
        scenes=[
            {"settings": {"execution": "interpreted"}},
            {"settings": {"execution": "compiled"}},
            {"settings": {}},
            {},
            "not a scene",
        ]
    )

    assert frame_compiled_scene_count(frame) == 1


@pytest.mark.asyncio
async def test_download_precompiled_frameos_release_extracts_required_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_root = tmp_path / "source" / "frameos-2026.5.14-debian-trixie-arm64"
    (source_root / "drivers").mkdir(parents=True)
    (source_root / "frameos").write_bytes(b"frameos")
    (source_root / "drivers" / "frameBuffer.so").write_bytes(b"driver")
    (source_root / "drivers" / "evdev.so").write_bytes(b"evdev")
    (source_root / "metadata.json").write_text(
        '{"slug":"debian-trixie-arm64","driver_libraries":["evdev.so","frameBuffer.so"]}\n',
        encoding="utf-8",
    )
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname=source_root.name)

    fake_download = _signing_download(archive)

    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    _trust_test_key(monkeypatch)
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    build_dir = tmp_path / "build"
    result = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(build_dir),
        temp_dir=str(tmp_path),
        build_id="build12345678",
        logger=logger,
    )

    assert Path(result.binary_path).read_bytes() == b"frameos"
    assert result.driver_library_names == ["frameBuffer.so", "evdev.so"]
    assert [Path(path).read_bytes() for path in result.driver_library_paths] == [b"driver", b"evdev"]
    assert Path(result.archive_path).is_file()
    assert result.cache_hit is False
    assert any("Downloading precompiled FrameOS release" in message for _level, message in logs)


def test_resolve_prebuilt_target_armv6():
    # armv6 must never fall back to armhf (ARMv7 artifacts SIGILL on ARM1176)
    # and resolves per-release like every other arch.
    assert resolve_prebuilt_target("debian", "trixie", "armv6l") == "debian-trixie-armv6"
    assert resolve_prebuilt_target("raspios", "trixie", "armv6l") == "debian-trixie-armv6"
    assert resolve_prebuilt_target("debian", "bookworm", "armv6l") == "debian-bookworm-armv6"
    assert resolve_prebuilt_target("debian", "trixie", "aarch64") == "debian-trixie-arm64"


@pytest.mark.asyncio
async def test_download_precompiled_frameos_release_reuses_cached_archive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    source_root = tmp_path / "source" / "frameos-2026.5.14-debian-trixie-arm64"
    (source_root / "drivers").mkdir(parents=True)
    (source_root / "frameos").write_bytes(b"frameos")
    (source_root / "drivers" / "frameBuffer.so").write_bytes(b"driver")
    (source_root / "drivers" / "evdev.so").write_bytes(b"evdev")
    (source_root / "metadata.json").write_text(
        '{"slug":"debian-trixie-arm64","driver_libraries":["evdev.so","frameBuffer.so"]}\n',
        encoding="utf-8",
    )
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname=source_root.name)

    download_calls: list[str] = []
    fake_download = _signing_download(archive, download_calls)
    _trust_test_key(monkeypatch)

    logs: list[tuple[str, str]] = []

    async def logger(level: str, message: str) -> None:
        logs.append((level, message))

    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    first = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(tmp_path / "build-first"),
        temp_dir=str(tmp_path),
        build_id="first1234567",
        logger=logger,
    )
    second = await download_precompiled_frameos_release(
        frame=SimpleNamespace(device="framebuffer", gpio_buttons=[]),
        target="debian-trixie-arm64",
        build_dir=str(tmp_path / "build-second"),
        temp_dir=str(tmp_path),
        build_id="second123456",
        logger=logger,
    )

    assert len([url for url in download_calls if not url.endswith(".minisig")]) == 1
    assert first.cache_hit is False
    assert second.cache_hit is True
    assert Path(second.binary_path).read_bytes() == b"frameos"
    assert any("Using cached precompiled FrameOS release" in message for _level, message in logs)


class _FakeStreamResponse:
    def __init__(self, status_code: int, body: bytes = b"") -> None:
        self.status_code = status_code
        self._body = body

    def raise_for_status(self) -> None:
        import httpx

        if self.status_code >= 400:
            request = httpx.Request("GET", "https://github.com/release")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    async def aiter_bytes(self):
        yield self._body


class _FakeStream:
    def __init__(self, outcome) -> None:
        self._outcome = outcome

    async def __aenter__(self):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome

    async def __aexit__(self, *exc) -> bool:
        return False


def _fake_async_client(outcomes: list):
    """An httpx.AsyncClient stand-in that pops one scripted outcome per GET."""

    class FakeAsyncClient:
        def __init__(self, **_kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        def stream(self, _method: str, _url: str):
            return _FakeStream(outcomes.pop(0))

    return FakeAsyncClient


@pytest.mark.asyncio
async def test_download_retries_transient_disconnects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    # The CI-observed flake: GitHub drops the connection before sending a
    # response. One attempt used to fail the whole build; the downloader now
    # retries and the third attempt's bytes land on disk.
    import httpx

    from app.tasks import precompiled_frameos

    outcomes = [
        httpx.RemoteProtocolError("Server disconnected without sending a response."),
        httpx.ConnectError("connection reset"),
        _FakeStreamResponse(200, b"release bytes"),
    ]
    monkeypatch.setattr(precompiled_frameos.httpx, "AsyncClient", _fake_async_client(outcomes))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(precompiled_frameos.asyncio, "sleep", no_sleep)

    destination = tmp_path / "release.tar.gz"
    await precompiled_frameos._download("https://github.com/release", destination, timeout=1.0)

    assert destination.read_bytes() == b"release bytes"
    assert not outcomes, "every scripted attempt should have been consumed"


@pytest.mark.asyncio
async def test_download_does_not_retry_missing_releases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    # A 404 is an answer, not a flake: retrying it would just hammer the
    # release host and delay the fallback to a source build.
    import httpx

    from app.tasks import precompiled_frameos

    outcomes = [_FakeStreamResponse(404)]
    monkeypatch.setattr(precompiled_frameos.httpx, "AsyncClient", _fake_async_client(outcomes))

    with pytest.raises(httpx.HTTPStatusError):
        await precompiled_frameos._download(
            "https://github.com/release", tmp_path / "missing.tar.gz", timeout=1.0
        )

    assert not outcomes


@pytest.mark.asyncio
async def test_download_gives_up_after_the_last_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import httpx

    from app.tasks import precompiled_frameos

    outcomes = [
        httpx.RemoteProtocolError("Server disconnected without sending a response.")
        for _ in range(precompiled_frameos.RELEASE_DOWNLOAD_ATTEMPTS)
    ]
    monkeypatch.setattr(precompiled_frameos.httpx, "AsyncClient", _fake_async_client(outcomes))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(precompiled_frameos.asyncio, "sleep", no_sleep)

    with pytest.raises(httpx.RemoteProtocolError):
        await precompiled_frameos._download(
            "https://github.com/release", tmp_path / "flaky.tar.gz", timeout=1.0
        )

    assert not outcomes


@pytest.mark.asyncio
async def test_a_tampered_cached_archive_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The cache dir is predictable and (by default) under /tmp: bytes planted
    there must fail the signature check and be fetched again, not deployed."""
    source_root = tmp_path / "source" / "frameos-2026.5.14-debian-trixie-arm64"
    (source_root / "drivers").mkdir(parents=True)
    (source_root / "frameos").write_bytes(b"frameos")
    (source_root / "metadata.json").write_text('{"slug":"debian-trixie-arm64","driver_libraries":[]}\n', encoding="utf-8")
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname=source_root.name)

    calls: list[str] = []
    _trust_test_key(monkeypatch)
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", _signing_download(archive, calls))

    async def logger(level: str, message: str) -> None:
        pass

    url = precompiled_frameos.precompiled_frameos_release_url("debian-trixie-arm64", "2026.5.14")
    assert url
    cache_path, hit = await precompiled_frameos._cached_release_archive(url, "debian-trixie-arm64", 1.0, logger)
    assert hit is False
    assert precompiled_frameos.precompiled_frameos_signature_path(cache_path).is_file()

    # Plant other bytes under the cached name: the signature no longer matches.
    planted = tmp_path / "planted.tar.gz"
    with tarfile.open(planted, "w:gz") as tar:
        tar.add(source_root, arcname="evil")
    shutil.copy2(planted, cache_path)
    before = len(calls)
    cache_path_again, hit = await precompiled_frameos._cached_release_archive(url, "debian-trixie-arm64", 1.0, logger)
    assert hit is False, "a cached archive that fails its signature must not count as a hit"
    assert len(calls) == before + 2
    assert cache_path_again.read_bytes() == archive.read_bytes()


@pytest.mark.asyncio
async def test_a_release_with_a_bad_signature_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    archive = tmp_path / "release.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        pass
    other_key = ed25519.Ed25519PrivateKey.generate()

    async def fake_download(url: str, destination: Path, _timeout: float) -> None:
        if url.endswith(".minisig"):
            digest = hashlib.blake2b(archive.read_bytes(), digest_size=64).digest()
            blob = b"ED" + b"\x01" * 8 + other_key.sign(digest)
            destination.write_text("untrusted comment: x\n" + base64.b64encode(blob).decode() + "\n")
        else:
            shutil.copy2(archive, destination)

    _trust_test_key(monkeypatch)
    monkeypatch.setenv("FRAMEOS_PRECOMPILED_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr("app.tasks.precompiled_frameos._download", fake_download)

    async def logger(level: str, message: str) -> None:
        pass

    url = precompiled_frameos.precompiled_frameos_release_url("debian-trixie-arm64", "2026.5.14")
    assert url
    with pytest.raises(RuntimeError, match="signature"):
        await precompiled_frameos._cached_release_archive(url, "debian-trixie-arm64", 1.0, logger)
    assert not precompiled_frameos.precompiled_frameos_cache_path(url).exists()
