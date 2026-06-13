"""Build flashable firmware images for embedded (ESP32) frames.

M1/M2 (see repo-root TODO.md): the firmware runs the FrameOS embedded
runtime — Wi-Fi provisioning, the Nim renderer (pixie on PSRAM), a Waveshare
e-ink driver, thin-client fetch, and OTA A/B updates. The build bakes
per-frame defaults into ``main/generated_config.h`` (backend URL, API key,
panel, pins), cross-compiles the Nim runtime via ``build_nim.sh`` when nim is
installed, and produces two artifacts: the merged image flashable at 0x0 and
the bare app image the device pulls over the air.

The pipeline mirrors the Buildroot SD image flow: an arq task builds the
image, status lives on the frame's ``embedded.firmware`` JSON, and download
endpoints serve the binaries.

Requires ESP-IDF on the machine running the worker: the ``IDF_PATH`` env var,
or a checkout at ``~/esp/esp-idf`` (see embedded/esp32/README.md).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from arq import ArqRedis as Redis
from arq.jobs import Job, JobStatus
from sqlalchemy.orm import Session

from app.drivers.waveshare import convert_waveshare_source, get_variant_folder, get_variant_keys
from app.models.frame import Frame, update_frame
from app.models.log import new_log as log
from app.tasks.utils import get_fresh_frame
from app.utils.token import secure_token

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_EMBEDDED_PLATFORM = "esp32-s3"
EMBEDDED_PLATFORM_ALIASES = {"", "esp32s3", "esp32-s3-devkitc-1"}
EMBEDDED_PROJECT_DIR = REPO_ROOT / "embedded" / "esp32"
EMBEDDED_IDF_TARGET = "esp32s3"
# Bump when the firmware project changes so existing "ready" images rebuild on next request
EMBEDDED_FIRMWARE_VERSION = 8  # enlarged 8MB flash layout with 3840K OTA slots
EMBEDDED_DEFAULT_PANEL = "EPD_7in5_V2"
# FOSB pixel formats. Keep in sync with fos_pixel_format_t in
# embedded/esp32/components/frameos_display/include/frameos_display.h.
FOS_PIXEL_1BPP = 1
FOS_PIXEL_DUAL_1BPP_RED = 2
FOS_PIXEL_DUAL_1BPP_YELLOW = 3
FOS_PIXEL_2BPP_GRAY = 4
FOS_PIXEL_2BPP_BWYR = 5
FOS_PIXEL_4BPP_7COLOR = 6
FOS_PIXEL_4BPP_SPECTRA6 = 7
FOS_PIXEL_4BPP_GRAY = 8
EMBEDDED_PIXEL_FORMAT_BY_COLOR = {
    "Black": FOS_PIXEL_1BPP,
    "BlackWhiteRed": FOS_PIXEL_DUAL_1BPP_RED,
    "BlackWhiteYellow": FOS_PIXEL_DUAL_1BPP_YELLOW,
    "FourGray": FOS_PIXEL_2BPP_GRAY,
    "BlackWhiteYellowRed": FOS_PIXEL_2BPP_BWYR,
    "SevenColor": FOS_PIXEL_4BPP_7COLOR,
    "SpectraSixColor": FOS_PIXEL_4BPP_SPECTRA6,
    "SixteenGray": FOS_PIXEL_4BPP_GRAY,
}
# These Waveshare variants are in the Linux catalog but not the ESP32 e-paper
# SPI component: IT8951 and the 12.48" family use different controller stacks.
EMBEDDED_UNSUPPORTED_PANELS = {
    "EPD_10in3",
    "EPD_12in48",
    "EPD_12in48b",
    "EPD_12in48b_V2",
}
EMBEDDED_PANEL_FORMATS = {
    key: EMBEDDED_PIXEL_FORMAT_BY_COLOR[convert_waveshare_source(key).color_option]
    for key in get_variant_keys()
    if key not in EMBEDDED_UNSUPPORTED_PANELS
    and (
        get_variant_folder(key) == "ePaper"
        or key == "EPD_13in3e"
    )
    and convert_waveshare_source(key).color_option in EMBEDDED_PIXEL_FORMAT_BY_COLOR
}
# Must mirror components/frameos_display/generate_selected_panel.py.
EMBEDDED_SUPPORTED_PANELS = {"none", *EMBEDDED_PANEL_FORMATS.keys()}
EMBEDDED_FLASH_OFFSET = "0x0"
# Memory guardrail (M4): the on-device renderer composites into an RGBA pixie
# buffer (4 B/px), packs it to the selected panel format, and needs headroom
# for the Nim heap + QuickJS. Keep the reserve in sync with
# FOS_RENDER_PSRAM_RESERVE in components/frameos_display/frameos_display.c.
EMBEDDED_RENDER_PSRAM_RESERVE_BYTES = 1536 * 1024
EMBEDDED_DEFAULT_PSRAM_BYTES = 8 * 1024 * 1024
EMBEDDED_RENDER_LOCAL = 0
EMBEDDED_RENDER_REMOTE = 1
EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS = int(
    os.environ.get("FRAMEOS_EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS", str(15 * 60))
)
ACTIVE_FIRMWARE_STATUSES = {"queued", "building"}
ACTIVE_ARQ_JOB_STATUSES = {JobStatus.deferred, JobStatus.queued, JobStatus.in_progress}

# idf.py builds are not safe to run concurrently in the same build directory
_build_lock = asyncio.Lock()


def normalize_embedded_platform(platform: str | None) -> str:
    value = (platform or "").strip()
    if value == SUPPORTED_EMBEDDED_PLATFORM or value in EMBEDDED_PLATFORM_ALIASES:
        return SUPPORTED_EMBEDDED_PLATFORM
    raise ValueError(f"Unsupported embedded platform: {value or '(empty)'}")


def embedded_artifact_dir() -> Path:
    return Path(
        os.environ.get("FRAMEOS_EMBEDDED_ARTIFACT_DIR")
        or (REPO_ROOT / "db" / "artifacts" / "embedded-firmware")
    )


def embedded_idf_path() -> Path:
    return Path(os.environ.get("IDF_PATH") or (Path.home() / "esp" / "esp-idf"))


def embedded_toolchain_available() -> bool:
    return (embedded_idf_path() / "export.sh").is_file()


def embedded_panel_for_frame(frame: Frame) -> str:
    """Map the frame's device string to a firmware panel name."""
    device = str(frame.device or "")
    if device.startswith("waveshare."):
        panel = device.split(".", 1)[1]
        if panel in EMBEDDED_SUPPORTED_PANELS:
            return panel
    return "none"


def embedded_module_psram_bytes(frame: Frame) -> int:
    """PSRAM on the target module. Defaults to 8MB (the S3 modules M2 ran on);
    override per-frame with ``device_config.psramMB`` / ``embedded.psramMB``."""
    for source in (frame.device_config, frame.embedded):
        if isinstance(source, dict):
            mb = source.get("psramMB", source.get("psram_mb"))
            if isinstance(mb, (int, float)) and not isinstance(mb, bool) and mb > 0:
                return int(mb * 1024 * 1024)
    return EMBEDDED_DEFAULT_PSRAM_BYTES


def embedded_render_mode_for_frame(frame: Frame) -> int:
    """Default render mode baked into the firmware image: local unless opted
    into remote/thin-client mode in device_config or embedded metadata."""
    for source in (frame.device_config, frame.embedded):
        if isinstance(source, dict):
            value = source.get("renderMode", source.get("render_mode"))
            if isinstance(value, str):
                normalized = value.strip().lower().replace("-", "_")
                if normalized in {"remote", "thin_client", "thinclient", "backend"}:
                    return EMBEDDED_RENDER_REMOTE
                if normalized in {"local", "on_device", "ondevice"}:
                    return EMBEDDED_RENDER_LOCAL
            elif isinstance(value, int) and not isinstance(value, bool):
                return EMBEDDED_RENDER_REMOTE if value == EMBEDDED_RENDER_REMOTE else EMBEDDED_RENDER_LOCAL
    return EMBEDDED_RENDER_LOCAL


def embedded_pixel_format_for_panel(panel: str) -> int:
    return EMBEDDED_PANEL_FORMATS.get(panel, FOS_PIXEL_1BPP)


def embedded_buffer_size(width: int, height: int, pixel_format: int) -> int:
    if pixel_format in (FOS_PIXEL_1BPP,):
        return ((width + 7) // 8) * height
    if pixel_format in (FOS_PIXEL_DUAL_1BPP_RED, FOS_PIXEL_DUAL_1BPP_YELLOW):
        return ((width + 7) // 8) * height * 2
    if pixel_format in (FOS_PIXEL_2BPP_GRAY, FOS_PIXEL_2BPP_BWYR):
        return ((width + 3) // 4) * height
    if pixel_format in (FOS_PIXEL_4BPP_7COLOR, FOS_PIXEL_4BPP_SPECTRA6, FOS_PIXEL_4BPP_GRAY):
        return ((width + 1) // 2) * height
    raise ValueError(f"Unsupported embedded pixel format: {pixel_format}")


def embedded_render_psram_bytes(width: int, height: int, pixel_format: int = FOS_PIXEL_1BPP) -> int:
    """PSRAM the on-device renderer needs for a width×height panel."""
    rgba = width * height * 4
    packed = embedded_buffer_size(width, height, pixel_format)
    return rgba + packed + EMBEDDED_RENDER_PSRAM_RESERVE_BYTES


def check_embedded_panel_fits_memory(frame: Frame) -> None:
    """Refuse a panel that can't be rendered on-device within the module PSRAM.

    The firmware applies the same check at boot and falls back to thin-client
    mode; failing the build early gives the user a clear, actionable error
    instead of a frame that silently never renders locally.
    """
    panel = embedded_panel_for_frame(frame)
    if panel == "none" or embedded_render_mode_for_frame(frame) == EMBEDDED_RENDER_REMOTE:
        return
    from app.drivers.devices import device_dimensions

    dims = device_dimensions(frame.device)
    if not dims:
        return
    width, height = dims
    need = embedded_render_psram_bytes(width, height, embedded_pixel_format_for_panel(panel))
    have = embedded_module_psram_bytes(frame)
    if need > have:
        raise ValueError(
            f"Panel {panel} ({width}x{height}) needs ~{need / (1024 * 1024):.1f} MB PSRAM to "
            f"render on-device but the target module has ~{have // (1024 * 1024)} MB. Pick a "
            f"smaller panel, a module with more PSRAM (set device_config.psramMB), or run the "
            f"frame in thin-client mode."
        )


def embedded_wifi_credentials(frame: Frame) -> tuple[str, str]:
    """Wi-Fi from the frame's network settings (same shape as the Pi flows)."""
    network = frame.network if isinstance(frame.network, dict) else {}
    ssid = str(network.get("wifiSSID") or "").strip()
    password = str(network.get("wifiPassword") or "")
    if "\n" in ssid or "\r" in ssid:
        raise ValueError("WiFi network cannot contain line breaks")
    if "\n" in password or "\r" in password:
        raise ValueError("WiFi password cannot contain line breaks")
    return ssid, password


def _generated_config_header(frame: Frame, wifi_ssid: str = "", wifi_password: str = "") -> str:
    """Per-frame compile-time defaults baked into the image (NVS overrides win).

    Includes the frame's API key and the frame's Wi-Fi network settings (the
    same per-frame `network` JSON the Pi flows use): flashing a frame-specific
    image fully provisions the device in one step. The captive portal / serial
    console remain available to override everything.
    """
    def c_str(value: object) -> str:
        return '"' + str(value or "").replace("\\", "\\\\").replace('"', '\\"') + '"'

    server_host = str(frame.server_host or "")
    server_port = int(frame.server_port or 8989)
    scheme = "https" if server_port == 443 else "http"
    backend_url = f"{scheme}://{server_host}:{server_port}" if server_host else ""
    if server_host and server_port in (80, 443):
        backend_url = f"{scheme}://{server_host}"

    lines = [
        "/* Generated by the FrameOS backend for this frame — do not edit. */",
        "#pragma once",
        f"#define FRAMEOS_DEFAULT_WIFI_SSID {c_str(wifi_ssid)}",
        f"#define FRAMEOS_DEFAULT_WIFI_PASS {c_str(wifi_password)}",
        f"#define FRAMEOS_DEFAULT_BACKEND_URL {c_str(backend_url)}",
        f"#define FRAMEOS_DEFAULT_API_KEY {c_str(frame.server_api_key)}",
        f"#define FRAMEOS_DEFAULT_FRAME_ID {int(frame.id)}",
        f"#define FRAMEOS_DEFAULT_PANEL {c_str(embedded_panel_for_frame(frame))}",
        f"#define FRAMEOS_DEFAULT_RENDER_MODE {embedded_render_mode_for_frame(frame)}",
        f"#define FRAMEOS_DEFAULT_INTERVAL_SEC {max(5, int(frame.interval or 300))}",
    ]
    pins = (frame.device_config or {}).get("pins")
    if isinstance(pins, dict):
        mapping = {"rst": "RST", "dc": "DC", "cs": "CS", "cs2": "CS2", "busy": "BUSY",
                   "sck": "SCK", "sclk": "SCK", "mosi": "MOSI", "pwr": "PWR"}
        for key, macro in mapping.items():
            value = pins.get(key)
            if isinstance(value, int):
                lines.append(f"#define FRAMEOS_DEFAULT_PIN_{macro} {value}")

    # Optional power-management settings (M4). Absent → firmware defaults
    # (no deep sleep, no battery pin); all still overridable from the device.
    device_config = frame.device_config or {}

    def _config_value(*keys: str) -> object:
        for key in keys:
            if key in device_config:
                return device_config[key]
        return None

    deep_sleep = _config_value("deepSleep", "deep_sleep")
    if isinstance(deep_sleep, bool):
        lines.append(f"#define FRAMEOS_DEFAULT_DEEP_SLEEP {1 if deep_sleep else 0}")
    wake_schedule = _config_value("wakeSchedule", "wake_schedule")
    if isinstance(wake_schedule, bool):
        lines.append(f"#define FRAMEOS_DEFAULT_WAKE_SCHEDULE {1 if wake_schedule else 0}")
    battery_pin = _config_value("batteryPin", "battery_pin")
    if isinstance(battery_pin, int) and not isinstance(battery_pin, bool):
        lines.append(f"#define FRAMEOS_DEFAULT_BATTERY_PIN {battery_pin}")
    battery_divider = _config_value("batteryDivider", "battery_divider")
    if isinstance(battery_divider, (int, float)) and not isinstance(battery_divider, bool):
        lines.append(f"#define FRAMEOS_DEFAULT_BATTERY_DIVIDER {float(battery_divider)}f")
    return "\n".join(lines) + "\n"


def ensure_embedded_frame_defaults(frame: Frame, platform: str | None = None) -> None:
    normalized_platform = normalize_embedded_platform(platform or (frame.embedded or {}).get("platform"))

    frame.mode = "embedded"
    if not frame.frame_host:
        frame.frame_host = f"frame{frame.id}.local" if frame.id else "frame.local"

    # No SSH, no HTTPS proxy, no agent on a microcontroller
    https_proxy = dict(frame.https_proxy or {})
    https_proxy["enable"] = False
    frame.https_proxy = https_proxy
    agent = dict(frame.agent or {})
    agent["agentEnabled"] = False
    agent["agentRunCommands"] = False
    agent["deployWithAgent"] = False
    frame.agent = agent
    frame.log_to_file = None

    embedded = dict(frame.embedded or {})
    embedded["platform"] = normalized_platform
    frame.embedded = embedded

    # The device authenticates its render/OTA pulls with the server API key
    if not frame.server_api_key:
        frame.server_api_key = secure_token(32)
    if not frame.device or frame.device == "web_only":
        frame.device = f"waveshare.{EMBEDDED_DEFAULT_PANEL}"


def clear_embedded_firmware(frame: Frame | Any) -> None:
    embedded = dict(getattr(frame, "embedded", None) or {})
    embedded.pop("firmware", None)
    frame.embedded = embedded


def latest_embedded_firmware(frame: Frame) -> dict[str, Any] | None:
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    firmware = embedded.get("firmware")
    if not isinstance(firmware, dict):
        return None
    if firmware.get("status") == "ready" and firmware.get("firmwareVersion") != EMBEDDED_FIRMWARE_VERSION:
        return {
            **firmware,
            "status": "stale",
            "error": "The generated firmware was built from an older firmware project version",
        }
    path = firmware.get("path")
    if firmware.get("status") == "ready" and isinstance(path, str) and not Path(path).is_file():
        return {**firmware, "status": "missing", "error": "The generated firmware file is missing"}
    return firmware


async def refresh_embedded_firmware_status(db: Session, redis: Redis, frame: Frame) -> dict[str, Any] | None:
    firmware = latest_embedded_firmware(frame)
    if not firmware or firmware.get("status") not in ACTIVE_FIRMWARE_STATUSES:
        return firmware
    if await _firmware_queue_job_active(redis, firmware):
        return firmware

    error = (
        "Firmware build stopped updating. "
        "The worker process probably exited; start the firmware build again."
    )
    recovered = {**firmware, "status": "error", "error": error, "completedAt": _utc_now()}
    await log(db, redis, int(frame.id), "stderr", f"Marking embedded firmware build as failed: {error}")
    await _set_firmware_status(db, redis, frame, recovered)
    return recovered


async def start_embedded_firmware(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    force: bool = False,
) -> tuple[bool, dict[str, Any]]:
    if not embedded_toolchain_available():
        raise ValueError(
            f"ESP-IDF toolchain not found at {embedded_idf_path()}. "
            "Set IDF_PATH or install it (see embedded/esp32/README.md)."
        )

    firmware = latest_embedded_firmware(frame)
    if firmware and firmware.get("status") == "ready" and not force:
        return False, firmware
    if firmware and firmware.get("status") in ACTIVE_FIRMWARE_STATUSES:
        if await _firmware_queue_job_active(redis, firmware):
            return False, firmware
        await log(db, redis, int(frame.id), "stderr",
                  "Recovering stale embedded firmware build state; previous worker job is no longer active")

    request_id = secure_token(12)
    queue_job_id = _queue_job_id(frame.id, request_id)
    queued_at = _utc_now()
    metadata: dict[str, Any] = {
        "status": "queued",
        "requestId": request_id,
        "queueJobId": queue_job_id,
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "queuedAt": queued_at,
        "startedAt": queued_at,
    }
    await _set_firmware_status(db, redis, frame, metadata)

    try:
        await redis.enqueue_job("embedded_firmware", id=int(frame.id), request_id=request_id, _job_id=queue_job_id)
    except Exception as exc:
        await _set_firmware_status(db, redis, frame, {
            **metadata,
            "status": "error",
            "error": f"Failed to enqueue embedded firmware build: {exc}",
            "completedAt": _utc_now(),
        })
        raise

    return True, latest_embedded_firmware(frame) or metadata


async def embedded_firmware_task(ctx: dict[str, Any], id: int, request_id: str | None = None):
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    frame: Optional[Frame] = get_fresh_frame(db, id)
    if frame is None:
        await log(db, redis, id, "stderr", "Frame not found")
        raise Exception("Frame not found")

    try:
        ensure_embedded_frame_defaults(frame)
        if request_id and not _firmware_request_matches(frame, request_id):
            await log(db, redis, id, "stderr", "Ignoring stale embedded firmware worker job")
            return
        await _build_firmware(db, redis, frame, request_id)
    except Exception as exc:
        frame = get_fresh_frame(db, id) or frame
        if not request_id or _firmware_request_matches(frame, request_id):
            current = latest_embedded_firmware(frame) or {}
            await _set_firmware_status(db, redis, frame, {
                **_preserved_queue_metadata(current),
                "status": "error",
                "platform": SUPPORTED_EMBEDDED_PLATFORM,
                "error": str(exc),
                "completedAt": _utc_now(),
            })
        await log(db, redis, id, "stderr", f"Embedded firmware build failed: {exc}")
        raise


async def _build_firmware(db: Session, redis: Redis, frame: Frame, request_id: str | None) -> None:
    if not EMBEDDED_PROJECT_DIR.is_dir():
        raise ValueError(f"Embedded firmware project not found at {EMBEDDED_PROJECT_DIR}")
    idf_path = embedded_idf_path()
    if not (idf_path / "export.sh").is_file():
        raise ValueError(f"ESP-IDF toolchain not found at {idf_path}")

    check_embedded_panel_fits_memory(frame)

    current = latest_embedded_firmware(frame) or {}
    started_at = _utc_now()
    await _set_firmware_status(db, redis, frame, {
        **_preserved_queue_metadata(current),
        "status": "building",
        "requestId": request_id or current.get("requestId"),
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "startedAt": started_at,
        "lastHeartbeatAt": started_at,
    })
    selected_panel = embedded_panel_for_frame(frame)
    await log(db, redis, int(frame.id), "stdout",
              f"Building ESP32-S3 firmware with ESP-IDF at {idf_path} (panel={selected_panel})")

    build_dir = EMBEDDED_PROJECT_DIR / "build"
    # export.sh refuses to run inside a foreign Python venv; scrub venv vars and
    # let it activate the ESP-IDF Python environment itself.
    env = {k: v for k, v in os.environ.items() if k not in {"VIRTUAL_ENV", "IDF_PYTHON_ENV_PATH"}}
    env["PATH"] = os.pathsep.join(
        p for p in env.get("PATH", "").split(os.pathsep) if "/.venv/" not in p and not p.endswith("/.venv/bin")
    )
    env["IDF_PATH"] = str(idf_path)
    env["IDF_TARGET"] = EMBEDDED_IDF_TARGET
    env["FRAMEOS_SELECTED_PANEL"] = selected_panel

    # Per-frame compile-time defaults (backend URL, API key, panel, pins, Wi-Fi)
    wifi_ssid, wifi_password = embedded_wifi_credentials(frame)
    generated_header = EMBEDDED_PROJECT_DIR / "main" / "generated_config.h"
    generated_header.write_text(_generated_config_header(
        frame, wifi_ssid=wifi_ssid, wifi_password=wifi_password))

    # Compiled-scene parameters: bake the frame's first scene into the Nim
    # build. Full scene-graph codegen for Xtensa is the M3 follow-up; for now
    # the name and background color flow through as compile-time defines.
    scenes = frame.scenes if isinstance(frame.scenes, list) else []
    if scenes and isinstance(scenes[0], dict):
        # The flags expand unquoted in build_nim.sh, so reduce values to a
        # safe charset instead of shell-quoting (quotes would survive the
        # expansion literally).
        def define_safe(value: str, fallback: str) -> str:
            cleaned = re.sub(r"[^A-Za-z0-9_.#-]+", "-", value).strip("-")
            return cleaned or fallback

        scene_name = define_safe(str(scenes[0].get("name") or scenes[0].get("id") or ""), "default")
        background = define_safe(str((scenes[0].get("settings") or {}).get("backgroundColor") or ""), "#ffffff")
        env["FRAMEOS_EXTRA_NIM_FLAGS"] = (
            f"-d:frameosSceneName={scene_name} "
            f"-d:frameosSceneBackground={background}"
        )

    # Cross-compile the Nim runtime (M2: on-device rendering). If nim is not
    # installed on the worker the firmware still builds, thin-client only.
    nim_step = ""
    if shutil.which("nim"):
        nim_step = "./build_nim.sh && "
    else:
        await log(db, redis, int(frame.id), "stderr",
                  "nim not found on the worker; building firmware without the on-device Nim runtime")
    # generated_config.h and a fresh nimcache require a CMake reconfigure: the
    # component globs nimcache/*.c at configure time.
    command = (f'source "$IDF_PATH/export.sh" >/dev/null 2>&1 && {nim_step}'
               'idf.py reconfigure >/dev/null && idf.py build merge-bin')

    async with _build_lock:
        process = await asyncio.create_subprocess_exec(
            "bash", "-c", command,
            cwd=str(EMBEDDED_PROJECT_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        output_tail: list[str] = []
        assert process.stdout is not None
        last_heartbeat = datetime.now(timezone.utc)
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                output_tail.append(text)
                del output_tail[:-50]
            now = datetime.now(timezone.utc)
            if (now - last_heartbeat).total_seconds() >= 15:
                last_heartbeat = now
                frame = get_fresh_frame(db, int(frame.id)) or frame
                current = latest_embedded_firmware(frame) or {}
                if current.get("status") == "building":
                    await _set_firmware_status(db, redis, frame, {**current, "lastHeartbeatAt": _utc_now()})
        returncode = await process.wait()

    if returncode != 0:
        tail = "\n".join(output_tail[-20:])
        raise ValueError(f"idf.py build failed with exit code {returncode}:\n{tail}")

    merged_bin = build_dir / "merged-binary.bin"
    if not merged_bin.is_file():
        raise ValueError(f"Build succeeded but {merged_bin} was not produced")

    # The OTA artifact is the bare app image (flashed by the device into the
    # inactive ota_0/ota_1 slot), not the merged 0x0 flash image.
    ota_bin = build_dir / "frameos_esp32.bin"
    if not ota_bin.is_file():
        raise ValueError(f"Build succeeded but {ota_bin} was not produced")

    artifact_dir = embedded_artifact_dir()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    filename = f"frameos-{SUPPORTED_EMBEDDED_PLATFORM}-frame{frame.id}.bin"
    artifact_path = artifact_dir / filename
    shutil.copyfile(merged_bin, artifact_path)
    ota_filename = f"frameos-{SUPPORTED_EMBEDDED_PLATFORM}-frame{frame.id}-ota.bin"
    ota_artifact_path = artifact_dir / ota_filename
    shutil.copyfile(ota_bin, ota_artifact_path)

    frame = get_fresh_frame(db, int(frame.id)) or frame
    current = latest_embedded_firmware(frame) or {}
    await _set_firmware_status(db, redis, frame, {
        **_preserved_queue_metadata(current),
        "status": "ready",
        "requestId": request_id or current.get("requestId"),
        "platform": SUPPORTED_EMBEDDED_PLATFORM,
        "firmwareVersion": EMBEDDED_FIRMWARE_VERSION,
        "filename": filename,
        "path": str(artifact_path),
        "size": artifact_path.stat().st_size,
        "sha256": _sha256(artifact_path),
        "flashOffset": EMBEDDED_FLASH_OFFSET,
        "panel": embedded_panel_for_frame(frame),
        "otaPath": str(ota_artifact_path),
        "otaSize": ota_artifact_path.stat().st_size,
        "otaSha256": _sha256(ota_artifact_path),
        "startedAt": current.get("startedAt") or started_at,
        "completedAt": _utc_now(),
        "downloadUrl": f"/api/frames/{frame.id}/embedded/firmware/download",
    })
    await log(db, redis, int(frame.id), "stdout",
              f"ESP32-S3 firmware ready: {filename} ({artifact_path.stat().st_size} bytes)")


async def _firmware_queue_job_active(redis: Redis, firmware: dict[str, Any]) -> bool:
    job_id = firmware.get("queueJobId")
    if not isinstance(job_id, str) or not job_id:
        return False
    try:
        status = await Job(job_id, redis).status()
        return status in ACTIVE_ARQ_JOB_STATUSES and not _firmware_inactive(firmware)
    except Exception:
        return not _firmware_inactive(firmware)


def _firmware_inactive(firmware: dict[str, Any]) -> bool:
    timestamp = _parse_utc(firmware.get("lastHeartbeatAt") or firmware.get("startedAt") or firmware.get("queuedAt"))
    if timestamp is None:
        return True
    return (datetime.now(timezone.utc) - timestamp).total_seconds() > EMBEDDED_FIRMWARE_INACTIVE_AFTER_SECONDS


def _parse_utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _queue_job_id(frame_id: int, request_id: str) -> str:
    return f"embedded_firmware:{frame_id}:{request_id}"


def _firmware_request_matches(frame: Frame, request_id: str) -> bool:
    firmware = latest_embedded_firmware(frame) or {}
    return firmware.get("requestId") == request_id


def _preserved_queue_metadata(firmware: dict[str, Any]) -> dict[str, Any]:
    return {
        key: firmware[key]
        for key in ("requestId", "queueJobId", "queuedAt")
        if isinstance(firmware.get(key), str) and firmware.get(key)
    }


async def _set_firmware_status(db: Session, redis: Redis, frame: Frame, firmware: dict[str, Any]) -> None:
    embedded = dict(frame.embedded or {})
    embedded["platform"] = normalize_embedded_platform(embedded.get("platform"))
    embedded["firmware"] = firmware
    frame.embedded = embedded
    await update_frame(db, redis, frame)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
