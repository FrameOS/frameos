from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.codegen.drivers_nim import COMPILATION_MODE_PRECOMPILED
from app.models.frame import Frame
from app.models.log import Log
from app.tasks.buildroot_image import BuildrootImageBuilder, ensure_buildroot_frame_defaults


TRUE_VALUES = {"1", "true", "yes", "on"}
RUN_BUILDROOT_E2E = os.environ.get("FRAMEOS_E2E_BUILDROOT", "").lower() in TRUE_VALUES

pytestmark = pytest.mark.skipif(
    not RUN_BUILDROOT_E2E,
    reason="set FRAMEOS_E2E_BUILDROOT=1 to run the real Buildroot SD image integration test",
)


def _say(message: str) -> None:
    print(f"[buildroot-e2e] {message}", flush=True)


def _frame(db) -> Frame:
    frame = Frame(
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
    return [log.line for log in db.query(Log).filter(Log.frame_id == frame.id).all()]


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
