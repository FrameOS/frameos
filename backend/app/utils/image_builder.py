import gzip
import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import ssl
import lzma
from pathlib import Path
from typing import Iterable

DOWNLOAD_URL = (
    "https://downloads.raspberrypi.org/raspios_lite_arm64/images/"
    "raspios_lite_arm64-2025-05-13/"
    "2025-05-13-raspios-bookworm-arm64-lite.img.xz"
)
CACHE_IMAGE = Path(tempfile.gettempdir()) / "frameos_base.img"
CACHE_ARCHIVE = CACHE_IMAGE.with_suffix(".img.xz")


def _ensure_base_image() -> Path:
    """Return path to a cached Raspberry Pi OS base image."""

    if os.environ.get("FRAMEOS_BASE_IMAGE_PATH"):
        path = Path(os.environ["FRAMEOS_BASE_IMAGE_PATH"])
        if not path.is_file():
            raise FileNotFoundError("Base image not found. Set FRAMEOS_BASE_IMAGE_PATH")
        return path

    if CACHE_IMAGE.exists():
        return CACHE_IMAGE

    CACHE_IMAGE.parent.mkdir(parents=True, exist_ok=True)

    if not CACHE_ARCHIVE.exists():
        try:
            with urllib.request.urlopen(DOWNLOAD_URL) as resp, open(
                CACHE_ARCHIVE, "wb"
            ) as f:
                shutil.copyfileobj(resp, f)
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, ssl.SSLError):
                context = ssl._create_unverified_context()
                with urllib.request.urlopen(
                    DOWNLOAD_URL, context=context
                ) as resp, open(CACHE_ARCHIVE, "wb") as f:
                    shutil.copyfileobj(resp, f)
            else:
                raise

    with lzma.open(CACHE_ARCHIVE) as f_in, open(CACHE_IMAGE, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)

    return CACHE_IMAGE


def _write_wifi_config(path: Path, ssid: str, password: str) -> None:
    contents = f"""country=US
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1

network={{
    ssid=\"{ssid}\"
    psk=\"{password}\"
}}
"""
    path.write_text(contents)


def _partition_info(image: Path, index: int) -> tuple[int, int]:
    """Return (offset_bytes, size_bytes) for partition ``index``."""
    with image.open("rb") as f:
        f.seek(0x1BE + index * 16)
        entry = f.read(16)
    start_sector = int.from_bytes(entry[8:12], "little")
    sectors = int.from_bytes(entry[12:16], "little")
    return start_sector * 512, sectors * 512


def _debugfs_run(image: Path, commands: list[str]) -> None:
    """Run a series of debugfs commands against ``image``."""
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        f.write("\n".join(commands) + "\n")
        cmd_file = f.name

    try:
        subprocess.run(
            [
                "debugfs",
                "-w",
                "-f",
                cmd_file,
                image,
            ],
            check=True,
        )
    finally:
        os.unlink(cmd_file)


def build_custom_image(
    *,
    wifi_ssid: str,
    wifi_password: str,
    hostname: str,
    ssh_keys: Iterable[str] | None = None,
    frame_json: dict | None = None,
) -> str:
    """Return path to a gzipped Raspberry Pi OS image with custom settings.

    The function expects ``FRAMEOS_BASE_IMAGE_PATH`` environment variable to
    point at a pre-downloaded Raspberry Pi OS image. Optionally ``FRAMEOS_AGENT_BINARY``
    can point to a pre-built ``frameos_agent`` binary that will be installed
    under ``/srv/frameos/agent/current`` in the resulting image.
    """

    base_image = str(_ensure_base_image())

    agent_binary = os.environ.get("FRAMEOS_AGENT_BINARY")

    output_dir = tempfile.mkdtemp()
    final_path = Path(output_dir) / "frameos.img.gz"

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        image_copy = tmp / "frameos.img"
        shutil.copy(base_image, image_copy)

        root_offset, root_size = _partition_info(image_copy, 1)
        root_img = tmp / "root.img"

        subprocess.run(
            [
                "dd",
                f"if={image_copy}",
                f"of={root_img}",
                "bs=512",
                f"skip={root_offset // 512}",
                f"count={root_size // 512}",
                "status=none",
            ],
            check=True,
        )

        cmds = [
            "mkdir /srv/frameos/agent/current",
            f"write {tmp}/wifi.conf /etc/wpa_supplicant/wpa_supplicant.conf",
            f"write {tmp}/hostname /etc/hostname",
        ]

        if ssh_keys:
            cmds += [
                "mkdir /home/pi/.ssh",
                f"write {tmp}/authorized_keys /home/pi/.ssh/authorized_keys",
            ]

        if frame_json is not None:
            cmds.append(f"write {tmp}/frame.json /srv/frameos/agent/current/frame.json")

        if agent_binary and os.path.exists(agent_binary):
            cmds.append(
                f"write {agent_binary} /srv/frameos/agent/current/frameos_agent"
            )

        _write_wifi_config(tmp / "wifi.conf", wifi_ssid, wifi_password)
        (tmp / "hostname").write_text(hostname + "\n")
        if ssh_keys:
            (tmp / "authorized_keys").write_text("\n".join(ssh_keys) + "\n")
        if frame_json is not None:
            (tmp / "frame.json").write_text(json.dumps(frame_json, indent=4) + "\n")

        _debugfs_run(root_img, cmds)

        subprocess.run(
            [
                "dd",
                f"if={root_img}",
                f"of={image_copy}",
                "bs=512",
                f"seek={root_offset // 512}",
                "conv=notrunc",
                "status=none",
            ],
            check=True,
        )

        gz_tmp = tmp / "image.gz"
        with open(image_copy, "rb") as f_in, gzip.open(gz_tmp, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)

        shutil.move(gz_tmp, final_path)

    return str(final_path)