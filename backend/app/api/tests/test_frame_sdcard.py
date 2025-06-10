import pytest
import subprocess

from app.models import new_frame
from app.models.settings import Settings
from app.utils import image_builder


def _noop_run(*args, **kwargs):
    return subprocess.CompletedProcess(args[0], 0)


@pytest.mark.asyncio
async def test_frame_sdcard(async_client, db, redis, tmp_path, monkeypatch):
    frame = await new_frame(db, redis, "Frame1", "localhost", "localhost")

    base_image = tmp_path / "base.img"
    base_image.write_bytes(b"\0" * 1024)
    monkeypatch.setenv("FRAMEOS_BASE_IMAGE_PATH", str(base_image))
    monkeypatch.setattr(image_builder, "_partition_offset", lambda *a, **k: 0)
    monkeypatch.setattr(subprocess, "run", _noop_run)
    monkeypatch.setattr(image_builder.platform, "system", lambda: "Linux")

    db.add(Settings(key="ssh_keys", value={"default_public": "ssh-rsa AAA"}))
    db.commit()

    payload = {"wifi_ssid": "MyWiFi", "wifi_password": "secret"}

    response = await async_client.post(f"/api/frames/{frame.id}/sdcard", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/gzip"
    assert response.content != b""