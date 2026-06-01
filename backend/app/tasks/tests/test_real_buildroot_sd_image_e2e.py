from __future__ import annotations

import hashlib
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

import httpx
import pytest

from app.codegen.drivers_nim import COMPILATION_MODE_PRECOMPILED
from app.models.frame import Frame
from app.models.log import Log
from app.tasks import buildroot_image as buildroot_image_module
from app.tasks.buildroot_image import BuildrootImageBuilder, ensure_buildroot_frame_defaults
from app.tasks.prebuilt_deps import fetch_prebuilt_manifest, resolve_prebuilt_target
from app.tenancy import ensure_default_project


TRUE_VALUES = {"1", "true", "yes", "on"}
RUN_BUILDROOT_E2E = os.environ.get("FRAMEOS_E2E_BUILDROOT", "").lower() in TRUE_VALUES

pytestmark = pytest.mark.skipif(
    not RUN_BUILDROOT_E2E,
    reason="set FRAMEOS_E2E_BUILDROOT=1 to run the real Buildroot SD image integration test",
)


def _say(message: str) -> None:
    print(f"[buildroot-e2e] {message}", flush=True)


def _frame(db) -> Frame:
    project = ensure_default_project(db)
    frame = Frame(
        project_id=project.id,
        name="BuildrootE2E",
        mode="buildroot",
        frame_host="frame-buildroot-e2e.local",
        frame_port=8787,
        frame_access_key="frame-access-key",
        frame_access="private",
        frame_admin_auth={"enabled": False, "user": "", "pass": ""},
        https_proxy={"enable": False, "port": 8443, "certs": {}},
        ssh_user="root",
        ssh_pass="",
        ssh_port=22,
        ssh_keys=[],
        server_host="frameos.local",
        server_port=8989,
        server_api_key="server-key",
        server_send_logs=True,
        status="uninitialized",
        width=800,
        height=480,
        device="web_only",
        interval=300,
        metrics_interval=60,
        scenes=[
            {
                "id": "buildroot-e2e-render",
                "name": "Buildroot E2E Render",
                "settings": {"execution": "interpreted", "refreshInterval": 300},
                "nodes": [
                    {
                        "id": "buildroot-e2e-event",
                        "type": "event",
                        "position": {"x": 0, "y": 0},
                        "data": {"keyword": "render"},
                    }
                ],
                "edges": [],
                "fields": [],
            }
        ],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        assets_path="/srv/assets",
        save_assets=True,
        upload_fonts="none",
        reboot={"enabled": "false"},
        control_code={"enabled": "false", "position": "top-right"},
        schedule={"events": []},
        gpio_buttons=[],
        network={
            "networkCheck": True,
            "networkCheckTimeoutSeconds": 1,
            "networkCheckUrl": "http://127.0.0.1/",
            "wifiHotspot": "bootOnly",
        },
        agent={
            "agentEnabled": True,
            "agentRunCommands": True,
            "agentSharedSecret": "buildroot-e2e-secret",
            "deployWithAgent": True,
        },
        buildroot={
            "platform": "raspberry-pi-zero-2-w",
            "compilationMode": COMPILATION_MODE_PRECOMPILED,
        },
    )
    ensure_buildroot_frame_defaults(frame)
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


def _log_lines(db, frame: Frame) -> list[str]:
    return [
        log.line
        for log in db.query(Log)
        .filter(Log.project_id == frame.project_id, Log.frame_id == frame.id)
        .all()
    ]


def _file_md5sum(path: Path) -> str:
    hasher = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _safe_extract(tar: tarfile.TarFile, path: Path) -> None:
    root = path.resolve()
    for member in tar.getmembers():
        member_path = (path / member.name).resolve()
        if os.path.commonpath([str(root), str(member_path)]) != str(root):
            raise RuntimeError("Tar file attempted to escape target directory")
    tar.extractall(path=path, filter="data")


def _normalize_component_dir(dest_dir: Path) -> None:
    entries = [path for path in dest_dir.iterdir() if path.name != ".build-info"]
    subdirs = [path for path in entries if path.is_dir()]
    files = [path for path in entries if path.is_file()]
    if files or len(subdirs) != 1:
        return
    inner = subdirs[0]
    for child in inner.iterdir():
        shutil.move(str(child), dest_dir / child.name)
    shutil.rmtree(inner)


def _lgpio_component_is_valid(path: Path) -> bool:
    return (path / "include" / "lgpio.h").is_file() and any(
        library.is_file()
        for pattern in ("liblgpio.so*", "librgpio.so*")
        for library in (path / "lib").glob(pattern)
    )


async def _ensure_lgpio_prebuilt_deps() -> None:
    target = resolve_prebuilt_target(
        buildroot_image_module.FRAMEOS_BUILD_TARGET.distro,
        buildroot_image_module.FRAMEOS_BUILD_TARGET.version,
        buildroot_image_module.FRAMEOS_BUILD_TARGET.arch,
    )
    if not target:
        raise RuntimeError("Buildroot E2E target has no matching prebuilt dependency target")

    manifest = await fetch_prebuilt_manifest()
    entry = manifest.get(target)
    if not entry:
        raise RuntimeError(f"Prebuilt dependency manifest has no entry for {target}")

    version = entry.version_for("lgpio", "unknown") or "unknown"
    url = entry.url_for("lgpio")
    if not url:
        raise RuntimeError(f"Prebuilt dependency manifest has no lgpio archive for {target}")

    dest_dir = buildroot_image_module.REPO_ROOT / "build" / "prebuilt-deps" / target / f"lgpio-{version}"
    marker = dest_dir / ".build-info"
    expected_marker = f"lgpio|{version}|{url}|{entry.md5_for('lgpio') or ''}"
    if marker.is_file() and marker.read_text() == expected_marker and _lgpio_component_is_valid(dest_dir):
        return

    shutil.rmtree(dest_dir, ignore_errors=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(fd)
    archive_path = Path(tmp_path)
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                with archive_path.open("wb") as fh:
                    async for chunk in response.aiter_bytes():
                        fh.write(chunk)
        expected_md5 = entry.md5_for("lgpio")
        if expected_md5 and _file_md5sum(archive_path) != expected_md5:
            raise RuntimeError(f"Prebuilt lgpio archive checksum mismatch for {target}")
        with tarfile.open(archive_path, "r:gz") as tar:
            _safe_extract(tar, dest_dir)
        _normalize_component_dir(dest_dir)
        if not _lgpio_component_is_valid(dest_dir):
            raise RuntimeError(f"Prebuilt lgpio archive for {target} did not contain runtime libraries")
        marker.write_text(expected_marker)
    finally:
        archive_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_real_buildroot_sd_image_generation_from_precompiled_release(
    async_client,
    db,
    redis,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FRAMEOS_ARTIFACT_DIR", os.environ.get("FRAMEOS_ARTIFACT_DIR", str(tmp_path / "artifacts")))
    monkeypatch.setenv(
        "FRAMEOS_BUILDROOT_CACHE_DIR",
        os.environ.get("FRAMEOS_BUILDROOT_CACHE_DIR", str(tmp_path / "buildroot-cache")),
    )
    monkeypatch.setenv("FRAMEOS_CROSS_CACHE", os.environ.get("FRAMEOS_CROSS_CACHE", str(tmp_path / "cross-cache")))
    monkeypatch.setenv("FRAMEOS_CROSS_MAKE_JOBS", os.environ.get("FRAMEOS_CROSS_MAKE_JOBS", "2"))

    frame = _frame(db)
    await _ensure_lgpio_prebuilt_deps()
    _say(f"building Buildroot SD image from precompiled releases for frame {frame.id}")
    metadata = await BuildrootImageBuilder(db=db, redis=redis, frame=frame).run()

    assert metadata["status"] == "ready"
    assert metadata["platform"] == "raspberry-pi-zero-2-w"
    assert metadata["compilationMode"] == COMPILATION_MODE_PRECOMPILED
    assert metadata["compressed"] is True
    image_path = Path(metadata["path"])
    assert image_path.is_file()
    assert image_path.suffix == ".gz"
    assert image_path.stat().st_size > 1024 * 1024

    db.expire_all()
    frame = db.get(Frame, frame.id)
    assert frame is not None
    sd_image = frame.buildroot["sdImage"]
    assert sd_image["status"] == "ready"
    assert sd_image["path"] == str(image_path)

    download_response = await async_client.get(f"/api/frames/{frame.id}/buildroot/sd_image/download")
    assert download_response.status_code == 200
    assert download_response.headers["content-type"].startswith("application/gzip")
    assert sd_image["filename"] in download_response.headers["content-disposition"]
    assert len(download_response.content) == image_path.stat().st_size
    assert download_response.content[:2] == b"\x1f\x8b"

    logs = "\n".join(_log_lines(db, frame))
    assert "Building FrameOS binary for Raspberry Pi Zero 2 W" in logs
    assert "Building FrameOS agent for Raspberry Pi Zero 2 W" in logs
    assert "Using precompiled FrameOS release" in logs
    assert "precompiled FrameOS agent release" in logs
    assert "Buildroot SD image ready" in logs
    assert "Falling back to source build" not in logs
    assert "Creating build archive" not in logs
    assert "Target supports cross compilation" not in logs
    _say(f"real Buildroot SD image ready at {image_path}")
