from __future__ import annotations

import asyncio
import gzip
import copy
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Awaitable, Literal, Optional, TypeVar
from types import SimpleNamespace
from urllib.parse import urljoin

from arq import ArqRedis as Redis
from arq.jobs import Job, JobStatus
import httpx
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.codegen.drivers_nim import COMPILATION_MODE_PRECOMPILED, frame_compilation_mode
from app.models.assets import Assets
from app.models.frame import (
    Frame,
    get_frame_json,
    get_interpreted_scenes_json,
    update_frame,
)
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryBuildResult
from app.tasks.deploy_remote import RemoteDeployer
from app.tasks.precompiled_remote import download_precompiled_remote_release
from app.tasks.precompiled_frameos import frame_compiled_scene_count, release_version
from app.tasks.setup_json_reset import (
    BOOT_AUTHORIZED_KEYS_FILE,
    BOOT_HOSTNAME_FILE,
    BOOT_ROOT_PASSWORD_FILE,
    BOOT_WIFI_CONNECTION_FILE,
    SETUP_JSON_RESET_SCRIPT_PATH,
    SETUP_JSON_RESET_SERVICE_NAME,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
    setup_json_reset_enabled,
    setup_json_reset_file_path,
)
from app.tasks.utils import get_fresh_frame
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.utils.build_environment import BuildEnvironmentProvider, selected_build_environment_provider
from app.utils.build_host import BuildHostConfig, get_build_executor_config
from app.utils.build_executor import (
    BuildExecutor,
    DockerMount,
    build_executor_display_name,
    create_build_executor,
    ensure_build_executor_configured,
)
from app.utils.cross_compile import CrossCompiler, TargetMetadata
from app.utils.modal_sandbox import ModalSandboxConfig
from app.utils.ssh_key_utils import select_ssh_keys_for_frame
from app.utils.token import secure_token
from app.utils.versions import current_frameos_version

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_BUILDROOT_PLATFORM = "raspberry-pi-zero-2-w"
BUILDROOT_HOST_CXXFLAGS = "-O2 -pipe -std=gnu++17"
BUILDROOT_HOST_CFLAGS = "-O2 -pipe"
BUILDROOT_JLEVEL = int(os.environ.get("FRAMEOS_BUILDROOT_JLEVEL", "0"))
BUILDROOT_BOOTSTRAP_SCRIPT_VERSION = "6"
BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION = 18
BUILDROOT_FRAMEOS_PARTITION_SIZE = os.environ.get("FRAMEOS_BUILDROOT_FRAMEOS_PARTITION_SIZE", "30M")
BUILDROOT_ASSETS_PARTITION_SIZE = os.environ.get("FRAMEOS_BUILDROOT_ASSETS_PARTITION_SIZE", "30M")
BUILDROOT_DATA_PARTITION_HEADROOM_BYTES = 8 * 1024 * 1024
BUILDROOT_DATA_PARTITION_HEADROOM_RATIO = 1.25
BUILDROOT_LOCAL_FONTS_DIR = REPO_ROOT / "frameos" / "assets" / "copied" / "fonts"
BUILDROOT_LOCAL_FONT_EXTENSIONS = {".ttf", ".txt", ".md"}
BUILDROOT_ARCHIVE_BASE_URL = os.environ.get("FRAMEOS_ARCHIVE_BASE_URL", "https://archive.frameos.net/")
BUILDROOT_PRECOMPILED_SD_IMAGE_RELEASE_BASE_URL = os.environ.get(
    "FRAMEOS_PRECOMPILED_SD_IMAGE_RELEASE_BASE_URL",
    os.environ.get("FRAMEOS_PRECOMPILED_RELEASE_BASE_URL", "https://github.com/FrameOS/frameos/releases/download/"),
)
BUILDROOT_PRECOMPILED_SD_IMAGE_TIMEOUT = float(
    os.environ.get("FRAMEOS_PRECOMPILED_SD_IMAGE_TIMEOUT", os.environ.get("FRAMEOS_PRECOMPILED_TIMEOUT", "60"))
)
BUILDROOT_BASE_MANIFEST_PATH = os.environ.get("FRAMEOS_BUILDROOT_BASE_MANIFEST_PATH", "buildroot-images/manifest.json")
BUILDROOT_BASE_MANIFEST_FILE = os.environ.get(
    "FRAMEOS_BUILDROOT_BASE_MANIFEST_FILE",
    str(REPO_ROOT / "tools" / "buildroot-images" / "manifest.json"),
)
BUILDROOT_BASE_USE_REMOTE = os.environ.get("FRAMEOS_BUILDROOT_BASE_USE_REMOTE", "").lower() in {"1", "true", "yes"}
BUILDROOT_BASE_TIMEOUT = float(os.environ.get("FRAMEOS_BUILDROOT_BASE_TIMEOUT", "60"))
BUILDROOT_DOCKER_NOFILE_LIMIT = int(os.environ.get("FRAMEOS_BUILDROOT_DOCKER_NOFILE_LIMIT", "65535"))
BUILDROOT_PROGRESS_LOG_INTERVAL_SECONDS = float(os.environ.get("FRAMEOS_BUILDROOT_PROGRESS_LOG_INTERVAL_SECONDS", "30"))
BUILDROOT_DOCKER_APT_DEPS = (
    "bc",
    "bison",
    "build-essential",
    "ca-certificates",
    "cpio",
    "curl",
    "file",
    "flex",
    "g++",
    "gfortran",
    "genimage",
    "git",
    "dosfstools",
    "e2fsprogs",
    "libncurses-dev",
    "libssl-dev",
    "make",
    "mtools",
    "perl",
    "python3",
    "rsync",
    "unzip",
    "wget",
    "xdg-utils",
    "xz-utils",
)
BUILDROOT_DOCKER_APT_DEPS_LINE = " ".join(BUILDROOT_DOCKER_APT_DEPS)
BUILDROOT_COMPOSE_TOOLS = ("genimage", "mkfs.vfat", "mcopy", "mlabel", "debugfs")
BUILDROOT_BOOT_PATCH_TOOLS = ("mcopy", "mlabel", "debugfs")
SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")
SAFE_RELEASE_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")
LEGACY_PLATFORM_ALIASES = {
    "",
    "pi-zero2",
    "pi-zero-2",
    "pi-zero-w2",
    "pi-zero-2-w",
    "raspberry-pi-zero2",
    "raspberry-pi-zero-2",
    "raspberry-pi-zero-w-2",
    "raspberrypi-zero-2-w",
    "raspberrypizero2w",
    "raspberrypizero2w_defconfig",
    "raspberrypizero2w_64_defconfig",
}

BUILDROOT_VERSION = os.environ.get("FRAMEOS_BUILDROOT_VERSION", "2025.02.13")
BUILDROOT_DEFCONFIG = "raspberrypizero2w_64_defconfig"
BUILDROOT_DOCKER_IMAGE = os.environ.get("FRAMEOS_BUILDROOT_DOCKER_IMAGE", "debian:bookworm")
BUILDROOT_IMAGE = os.environ.get("FRAMEOS_BUILDROOT_IMAGE")
BUILDROOT_IMAGE_REPO = os.environ.get("FRAMEOS_BUILDROOT_IMAGE_REPO", "frameos/frameos-buildroot")
BUILDROOT_IMAGE_TAG = os.environ.get("FRAMEOS_BUILDROOT_IMAGE_TAG", "latest")
BUILDROOT_FORCE_LOCAL_BUILD = os.environ.get(
    "FRAMEOS_BUILDROOT_FORCE_LOCAL_BUILD",
    "0",
).lower() in {"1", "true", "yes", "on"}
BUILDROOT_SKIP_PULL = os.environ.get(
    "FRAMEOS_BUILDROOT_SKIP_PULL",
    "0",
).lower() in {"1", "true", "yes", "on"}
BUILDROOT_IMAGE_STALE_AFTER_SECONDS = int(
    os.environ.get("FRAMEOS_BUILDROOT_IMAGE_STALE_AFTER_SECONDS", str(6 * 60 * 60))
)
# Building jobs heartbeat through progress logs. After two missed progress updates,
# the UI should surface a real failure instead of waiting indefinitely.
BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS = int(
    os.environ.get(
        "FRAMEOS_BUILDROOT_IMAGE_BUILD_INACTIVE_AFTER_SECONDS",
        os.environ.get("FRAMEOS_BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS", str(90)),
    )
)
BUILDROOT_IMAGE_QUEUE_INACTIVE_AFTER_SECONDS = int(
    os.environ.get("FRAMEOS_BUILDROOT_IMAGE_QUEUE_INACTIVE_AFTER_SECONDS", str(10 * 60))
)
BUILDROOT_IMAGE_HEARTBEAT_INTERVAL_SECONDS = max(1, min(60, BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS // 3))
BUILDROOT_IMAGES_DIGESTS_PATH = os.environ.get("FRAMEOS_BUILDROOT_IMAGES_DIGESTS_PATH", str(REPO_ROOT / "buildroot-images.json"))
BUILDROOT_BOOT_LOGO_SOURCE = REPO_ROOT / "backend" / "app" / "tasks" / "assets" / "frameos-boot-logo.png"
BUILDROOT_BOOT_LOGO_WORK_PATH = "/work/frameos-boot-logo.png"
BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH = "/usr/sbin/frameos-expand-sd-card"
BUILDROOT_EXPAND_SD_CARD_SERVICE_NAME = "frameos-expand-sd-card.service"
BUILDROOT_DEFAULT_BOOT_CONFIG_LINES = (
    # Keep a small firmware framebuffer reserve for standard HDMI output while
    # returning the rest of the Pi Zero 2 W's 512MB RAM to Linux/userland.
    "gpu_mem=32",
)
BACKEND_ROOT = REPO_ROOT / "backend"
BUILDROOT_DOCKERFILE = BACKEND_ROOT / "tools" / "buildroot.Dockerfile"
FRAMEOS_BUILD_TARGET = TargetMetadata(
    arch="aarch64",
    distro="debian",
    version="bookworm",
)
ACTIVE_SD_IMAGE_STATUSES = {"queued", "building"}
ACTIVE_ARQ_JOB_STATUSES = {
    JobStatus.deferred,
    JobStatus.queued,
    JobStatus.in_progress,
}
T = TypeVar("T")


def normalize_buildroot_platform(platform: str | None) -> str:
    value = (platform or "").strip()
    if value == SUPPORTED_BUILDROOT_PLATFORM or value in LEGACY_PLATFORM_ALIASES:
        return SUPPORTED_BUILDROOT_PLATFORM
    raise ValueError(f"Unsupported Buildroot platform: {value or '(empty)'}")


def buildroot_artifact_dir() -> Path:
    return Path(os.environ.get("FRAMEOS_ARTIFACT_DIR") or (REPO_ROOT / "db" / "artifacts" / "sd-images"))


def buildroot_cache_dir() -> Path:
    return Path(os.environ.get("FRAMEOS_BUILDROOT_CACHE_DIR") or (buildroot_artifact_dir() / ".buildroot-cache"))


def buildroot_source_dir() -> Path:
    return Path(
        os.environ.get("FRAMEOS_BUILDROOT_SOURCE_DIR")
        or (buildroot_cache_dir() / f"buildroot-{BUILDROOT_VERSION}")
    )


def buildroot_output_cache_dir() -> Path:
    return Path(os.environ.get("FRAMEOS_BUILDROOT_OUTPUT_CACHE_DIR") or (buildroot_cache_dir() / "output"))


def buildroot_base_cache_dir() -> Path:
    return Path(os.environ.get("FRAMEOS_BUILDROOT_BASE_CACHE_DIR") or (buildroot_cache_dir() / "base-images"))


def buildroot_precompiled_sd_image_cache_dir() -> Path:
    return Path(
        os.environ.get("FRAMEOS_PRECOMPILED_SD_IMAGE_CACHE_DIR")
        or (buildroot_cache_dir() / "precompiled-sd-images")
    )


@dataclass(slots=True)
class PrecompiledBuildrootSdImageResult:
    release_url: str
    archive_path: Path
    cache_hit: bool = False


def _get_frame_settings(db: Session | None, frame: Frame) -> dict:
    return get_settings_dict(db, project_id=getattr(frame, "project_id", None))


@lru_cache(maxsize=1)
def _buildroot_digest_map() -> dict[str, str]:
    path = Path(BUILDROOT_IMAGES_DIGESTS_PATH)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    raw_images = payload.get("images") if isinstance(payload, dict) else None
    if not isinstance(raw_images, dict):
        return {}

    digests: dict[str, str] = {}
    for image_name, image_data in raw_images.items():
        if not isinstance(image_name, str) or not isinstance(image_data, dict):
            continue
        digest = image_data.get("digest")
        if isinstance(digest, str) and digest:
            digests[image_name] = digest
    return digests


@lru_cache(maxsize=1)
def _frameos_version() -> str:
    return current_frameos_version() or ""


async def _buildroot_base_manifest() -> dict[str, Any]:
    manifest_file = Path(BUILDROOT_BASE_MANIFEST_FILE)
    if manifest_file.is_file() and not BUILDROOT_BASE_USE_REMOTE:
        return json.loads(manifest_file.read_text(encoding="utf-8"))

    manifest_url = urljoin(_normalize_url_base(BUILDROOT_ARCHIVE_BASE_URL), BUILDROOT_BASE_MANIFEST_PATH)
    async with httpx.AsyncClient(timeout=BUILDROOT_BASE_TIMEOUT) as client:
        response = await client.get(manifest_url)
        response.raise_for_status()
        return response.json()


def _normalize_url_base(url: str) -> str:
    return url if url.endswith("/") else f"{url}/"


def precompiled_buildroot_sd_image_release_url(platform: str, version: str | None = None) -> str | None:
    resolved_version = version or release_version()
    if not resolved_version:
        return None
    normalized_platform = normalize_buildroot_platform(platform)
    if not SAFE_RELEASE_SEGMENT.fullmatch(resolved_version) or not SAFE_RELEASE_SEGMENT.fullmatch(normalized_platform):
        return None
    base = _normalize_url_base(BUILDROOT_PRECOMPILED_SD_IMAGE_RELEASE_BASE_URL)
    filename = f"frameos-{resolved_version}-{normalized_platform}-buildroot.img.gz"
    return urljoin(base, f"v{resolved_version}/{filename}")


def precompiled_buildroot_sd_image_cache_path(url: str) -> Path:
    filename = url.rsplit("/", 1)[-1] or "frameos-buildroot.img.gz"
    safe_filename = SAFE_SEGMENT.sub("_", filename)
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return buildroot_precompiled_sd_image_cache_dir() / f"{digest}-{safe_filename}"


async def download_precompiled_buildroot_sd_image(
    *,
    platform: str,
    logger,
    timeout: float = BUILDROOT_PRECOMPILED_SD_IMAGE_TIMEOUT,
) -> PrecompiledBuildrootSdImageResult | None:
    url = precompiled_buildroot_sd_image_release_url(platform)
    if not url:
        await logger("stderr", f"No full precompiled Buildroot SD image release URL is available for {platform}")
        return None

    cache_path = precompiled_buildroot_sd_image_cache_path(url)
    if cache_path.is_file() and cache_path.stat().st_size > 0:
        await logger("stdout", f"Using cached full precompiled Buildroot SD image release for {platform}")
        return PrecompiledBuildrootSdImageResult(release_url=url, archive_path=cache_path, cache_hit=True)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    await logger("stdout", f"Checking for full precompiled Buildroot SD image release for {platform}")
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{cache_path.name}.",
            suffix=".part",
            dir=cache_path.parent,
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)

        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                if response.status_code == 404:
                    await logger("stdout", f"No full precompiled Buildroot SD image release found for {platform}")
                    return None
                response.raise_for_status()
                with temp_path.open("wb") as output:
                    async for chunk in response.aiter_bytes():
                        output.write(chunk)

        if not temp_path.is_file() or temp_path.stat().st_size == 0:
            await logger("stderr", "Downloaded full precompiled Buildroot SD image release was empty")
            return None
        os.replace(temp_path, cache_path)
        temp_path = None
        return PrecompiledBuildrootSdImageResult(release_url=url, archive_path=cache_path)
    except httpx.HTTPStatusError as exc:
        await logger(
            "stderr",
            f"Could not use full precompiled Buildroot SD image release for {platform}: HTTP {exc.response.status_code}",
        )
        return None
    except httpx.RequestError as exc:
        await logger("stderr", f"Could not use full precompiled Buildroot SD image release for {platform}: {exc}")
        return None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


async def resolve_buildroot_base_entry(platform: str, frameos_version: str | None = None) -> dict[str, Any]:
    normalized_platform = normalize_buildroot_platform(platform)
    wanted_version = frameos_version if frameos_version is not None else _frameos_version()
    manifest = await _buildroot_base_manifest()
    entries = [entry for entry in manifest.get("entries", []) if entry.get("platform") == normalized_platform]
    if not entries:
        raise RuntimeError(f"No cached Buildroot base image found for {normalized_platform}")

    if wanted_version:
        for entry in entries:
            if entry.get("frameos_version") == wanted_version:
                return entry

    return max(entries, key=lambda entry: str(entry.get("updated_at") or ""))


async def ensure_buildroot_base_image(entry: dict[str, Any], destination_dir: Path) -> Path:
    object_key = entry.get("object_key")
    sha256 = entry.get("sha256")
    if not isinstance(object_key, str) or not object_key:
        raise RuntimeError("Buildroot base manifest entry is missing object_key")
    if not isinstance(sha256, str) or not sha256:
        raise RuntimeError("Buildroot base manifest entry is missing sha256")

    destination_dir.mkdir(parents=True, exist_ok=True)
    image_name = f"{entry.get('platform', 'buildroot')}-{sha256[:16]}.img"
    image_path = destination_dir / image_name
    if image_path.is_file() and _sha256(image_path) == sha256:
        return image_path

    archive_path = destination_dir / f"{image_name}.gz"
    archive_url = urljoin(_normalize_url_base(BUILDROOT_ARCHIVE_BASE_URL), object_key)
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.get(archive_url)
        response.raise_for_status()
        archive_path.write_bytes(response.content)

    with gzip.open(archive_path, "rb") as source, image_path.open("wb") as output:
        shutil.copyfileobj(source, output)
    archive_path.unlink(missing_ok=True)

    actual = _sha256(image_path)
    if actual != sha256:
        image_path.unlink(missing_ok=True)
        raise RuntimeError(f"Downloaded Buildroot base image checksum mismatch: expected {sha256}, got {actual}")
    return image_path


def _service_runtime_lines(
    console_output: bool,
    environment: dict[str, str] | None,
) -> list[str]:
    lines: list[str] = []
    for key, value in (environment or {}).items():
        lines.append(f"Environment={key}={value}")
    if console_output:
        lines.extend([
            "StandardOutput=journal+console",
            "StandardError=journal+console",
        ])
    return lines


def render_systemd_service(
    source: Path,
    *,
    user: str,
    console_output: bool = False,
    environment: dict[str, str] | None = None,
) -> str:
    service = source.read_text(encoding="utf-8").replace("%I", user)
    service_lines = service.splitlines()
    rendered_lines: list[str] = []
    in_service = False
    inserted = False
    for line in service_lines:
        if line == "[Service]":
            in_service = True
            rendered_lines.append(line)
            continue
        if in_service and line.startswith("[") and line.endswith("]"):
            if not inserted:
                rendered_lines.extend(_service_runtime_lines(console_output, environment))
                inserted = True
            in_service = False
        rendered_lines.append(line)
    if in_service and not inserted:
        rendered_lines.extend(_service_runtime_lines(console_output, environment))
    return "\n".join(rendered_lines) + "\n"


def render_buildroot_frameos_service() -> str:
    service = render_systemd_service(
        REPO_ROOT / "frameos" / "frameos.service",
        user="root",
        environment={
            "FRAMEOS_HOME": "/srv/frameos/current",
            "LD_LIBRARY_PATH": "/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib",
        },
    )
    return service.replace(
        "After=network.target\n",
        "Wants=NetworkManager.service\nAfter=network.target NetworkManager.service\n",
        1,
    )


def stage_buildroot_frameos_service(root: Path) -> None:
    systemd_dir = root / "etc" / "systemd" / "system"
    wants_dir = systemd_dir / "multi-user.target.wants"
    systemd_dir.mkdir(parents=True, exist_ok=True)
    wants_dir.mkdir(parents=True, exist_ok=True)
    (systemd_dir / "frameos.service").write_text(render_buildroot_frameos_service(), encoding="utf-8")
    link = wants_dir / "frameos.service"
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to("../frameos.service")


def _apply_boot_config_lines(content: str, requested_lines: list[str]) -> tuple[str, bool]:
    lines = content.splitlines()
    changed = False
    for requested_line in requested_lines:
        line = requested_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            removed_line = line[1:]
            before = len(lines)
            lines = [existing for existing in lines if existing != removed_line]
            if len(lines) != before:
                changed = True
        else:
            if line.split("=", 1)[0] == "gpu_mem":
                before = len(lines)
                lines = [
                    existing for existing in lines
                    if existing == line or
                    existing.split("=", 1)[0] not in {"gpu_mem", "gpu_mem_256", "gpu_mem_512", "gpu_mem_1024"}
                ]
                if len(lines) != before:
                    changed = True
            if any(existing == line for existing in lines):
                continue
            commented_line = f"#{line}"
            before = len(lines)
            lines = [existing for existing in lines if existing != commented_line]
            if len(lines) != before:
                changed = True
            if not any(existing == line for existing in lines):
                lines.append(line)
                changed = True
    return ("\n".join(lines).strip() + "\n", changed)


def _merge_boot_config_lines(content: str, requested_lines: list[str]) -> str:
    merged, changed = _apply_boot_config_lines(content, requested_lines)
    if not changed:
        return content
    return merged


def _frame_boot_config_lines(frame: Frame) -> list[str]:
    lines: list[str] = list(BUILDROOT_DEFAULT_BOOT_CONFIG_LINES)
    seen: set[str] = set(lines)
    for driver in drivers_for_frame(frame).values():
        for line in getattr(driver, "lines", []) or []:
            normalized = str(line).strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            lines.append(normalized)
    return lines


def _buildroot_sd_image_config_payload(frame: Frame | Any) -> dict[str, Any]:
    if hasattr(frame, "to_dict"):
        payload = dict(frame.to_dict())
    else:
        payload = dict(getattr(frame, "__dict__", {}))

    for key in (
        "_sa_instance_state",
        "archived",
        "status",
        "version",
        "last_log_at",
        "last_successful_deploy",
        "last_successful_deploy_at",
        "terminal_history",
    ):
        payload.pop(key, None)

    buildroot = dict(payload.get("buildroot") or {})
    buildroot.pop("sdImage", None)
    payload["buildroot"] = buildroot
    return payload


def _buildroot_setup_payload(db: Session | None, frame: Frame | Any) -> dict[str, Any]:
    payload = get_frame_json(db, frame)
    payload["scenes"] = list(getattr(frame, "scenes", []) or [])
    return payload


def buildroot_sd_image_config_fingerprint(frame: Frame | Any) -> str:
    payload = _buildroot_sd_image_config_payload(frame)
    encoded = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def clear_buildroot_sd_image(frame: Frame | Any) -> None:
    buildroot = dict(getattr(frame, "buildroot", None) or {})
    buildroot.pop("sdImage", None)
    frame.buildroot = buildroot


def _boot_setup_payload_path(boot_overlay_dir: Path, setup_file_path: str) -> Path:
    relative_path = setup_file_path.lstrip("/")
    if relative_path == "boot" or not relative_path or not relative_path.startswith("boot/"):
        raise ValueError("Setup JSON payload path must name a file below /boot")
    relative_path = relative_path[len("boot/"):]
    return boot_overlay_dir / relative_path


def ensure_buildroot_frame_defaults(frame: Frame, platform: str | None = None) -> None:
    normalized_platform = normalize_buildroot_platform(platform or (frame.buildroot or {}).get("platform"))

    frame.mode = "buildroot"
    frame.ssh_user = "root"
    if not frame.frame_host:
        frame.frame_host = f"frame{frame.id}.local" if frame.id else "frame.local"
    frame.assets_path = "/srv/assets"
    frame.log_to_file = None
    if getattr(frame, "image_engine", None) == "imagemagick":
        frame.image_engine = ""

    https_proxy = dict(frame.https_proxy or {})
    https_proxy["enable"] = False
    frame.https_proxy = https_proxy

    agent = dict(frame.agent or {})
    if not agent.get("agentSharedSecret"):
        agent["agentSharedSecret"] = secure_token(32)
    agent["agentEnabled"] = True
    agent["agentRunCommands"] = True
    agent["deployWithAgent"] = True
    frame.agent = agent

    network = dict(frame.network or {})
    network.setdefault("networkCheck", True)
    network.setdefault("networkCheckTimeoutSeconds", 30)
    network.setdefault("networkCheckUrl", "https://networkcheck.frameos.net/")
    network["wifiHotspot"] = "bootOnly"
    network.setdefault("wifiHotspotSsid", "FrameOS-Setup")
    network.setdefault("wifiHotspotPassword", "frame1234")
    network.setdefault("wifiHotspotTimeoutSeconds", 300)
    frame.network = network

    buildroot = dict(frame.buildroot or {})
    buildroot["platform"] = normalized_platform
    buildroot.pop("setupJsonResetFilePath", None)
    frame.buildroot = buildroot


def validate_buildroot_network(network: dict[str, Any] | None) -> tuple[str, str]:
    network = network if isinstance(network, dict) else {}
    ssid = str(network.get("wifiSSID") or "").strip()
    password = str(network.get("wifiPassword") or "")
    if "\n" in ssid or "\r" in ssid:
        raise ValueError("WiFi network cannot contain line breaks")
    if "\n" in password or "\r" in password:
        raise ValueError("WiFi password cannot contain line breaks")
    if bool(ssid) != bool(password):
        raise ValueError("WiFi network and password must be provided together")
    return ssid, password


def validate_buildroot_wifi_credentials(frame: Frame) -> tuple[str, str]:
    network = frame.network if isinstance(frame.network, dict) else {}
    return validate_buildroot_network(network)


def _sd_image_base_matches_current(sd_image: dict[str, Any], current_base_entry: dict[str, Any] | None) -> bool:
    if not current_base_entry:
        return True
    base_image = sd_image.get("baseImage")
    if not isinstance(base_image, dict):
        return False
    object_key = current_base_entry.get("object_key")
    sha256 = current_base_entry.get("sha256")
    if object_key and base_image.get("objectKey") != object_key:
        return False
    if sha256 and base_image.get("sha256") != sha256:
        return False
    return True


def latest_buildroot_sd_image(frame: Frame, current_base_entry: dict[str, Any] | None = None) -> dict[str, Any] | None:
    buildroot = frame.buildroot if isinstance(frame.buildroot, dict) else {}
    sd_image = buildroot.get("sdImage")
    if not isinstance(sd_image, dict):
        return None
    path = sd_image.get("path")
    current_compilation_mode = frame_compilation_mode(frame)
    if sd_image.get("status") == "ready" and sd_image.get("compilationMode") != current_compilation_mode:
        return {
            **sd_image,
            "status": "stale",
            "error": "The generated image was built with a different compilation mode",
        }
    if sd_image.get("status") == "ready" and sd_image.get("customizationVersion") != BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION:
        return {
            **sd_image,
            "status": "stale",
            "error": "The generated image was built with an older SD image customization version",
        }
    if (
        sd_image.get("status") == "ready"
        and not sd_image.get("precompiledSdImage")
        and not _sd_image_base_matches_current(sd_image, current_base_entry)
    ):
        return {
            **sd_image,
            "status": "stale",
            "error": "The generated image was built with an older Buildroot base image",
        }
    if sd_image.get("status") == "ready" and isinstance(path, str) and not Path(path).is_file():
        return {**sd_image, "status": "missing", "error": "The generated image file is missing"}
    return sd_image


async def refresh_buildroot_sd_image_status(
    db: Session,
    redis: Redis,
    frame: Frame,
    current_base_entry: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    sd_image = latest_buildroot_sd_image(frame, current_base_entry)
    if not sd_image or sd_image.get("status") not in ACTIVE_SD_IMAGE_STATUSES:
        return sd_image
    if await _buildroot_sd_image_queue_job_active(redis, sd_image):
        return sd_image

    checked_at = _utc_now()
    error = (
        "SD card image generation stopped updating. "
        "The worker process probably exited; start the SD card build again."
    )
    recovered = {
        **sd_image,
        "status": "error",
        "error": error,
        "completedAt": checked_at,
    }
    await log(
        db,
        redis,
        int(frame.id),
        "stderr",
        f"Marking Buildroot SD image generation as failed: {error}",
    )
    await _set_sd_image_status(db, redis, frame, recovered)
    return recovered


def can_use_precompiled_buildroot_sd_image(frame: Frame) -> bool:
    return frame_compilation_mode(frame) == COMPILATION_MODE_PRECOMPILED and frame_compiled_scene_count(frame) == 0


def buildroot_sd_image_no_build_environment_message(requirement: str) -> str:
    if os.environ.get("HASSIO_RUN_MODE"):
        return (
            "Home Assistant add-on Buildroot SD image generation runs inside the existing add-on container "
            f"and requires {requirement}. Configure a build host or Modal sandbox for builds that need "
            "compilation or composed-image fallback."
        )
    return (
        "Buildroot SD image generation without Docker, build host, or Modal sandboxes requires "
        f"{requirement}."
    )


async def start_buildroot_sd_image(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    force: bool = False,
) -> tuple[bool, dict[str, Any]]:
    current_base_entry = None
    try:
        current_base_entry = await resolve_buildroot_base_entry(SUPPORTED_BUILDROOT_PLATFORM)
    except Exception:
        if not can_use_precompiled_buildroot_sd_image(frame):
            raise
    sd_image = latest_buildroot_sd_image(frame, current_base_entry)
    if sd_image and sd_image.get("status") == "ready" and not force:
        return False, sd_image

    if sd_image and sd_image.get("status") in ACTIVE_SD_IMAGE_STATUSES:
        if await _buildroot_sd_image_queue_job_active(redis, sd_image):
            return False, sd_image
        await log(
            db,
            redis,
            int(frame.id),
            "stderr",
            "Recovering stale Buildroot SD image generation state; previous worker job is no longer active",
        )

    validate_buildroot_wifi_credentials(frame)

    request_id = secure_token(12)
    queue_job_id = _queue_job_id(frame.id, request_id)
    queued_at = _utc_now()
    metadata: dict[str, Any] = {
        "status": "queued",
        "requestId": request_id,
        "queueJobId": queue_job_id,
        "platform": SUPPORTED_BUILDROOT_PLATFORM,
        "queuedAt": queued_at,
        "startedAt": queued_at,
    }
    await _set_sd_image_status(db, redis, frame, metadata)

    try:
        await buildroot_sd_image(int(frame.id), redis, request_id=request_id, queue_job_id=queue_job_id)
    except Exception as exc:
        await _set_sd_image_status(
            db,
            redis,
            frame,
            {
                **metadata,
                "status": "error",
                "error": f"Failed to enqueue Buildroot SD image generation: {exc}",
                "completedAt": _utc_now(),
            },
        )
        raise

    return True, latest_buildroot_sd_image(frame) or metadata


async def buildroot_sd_image(
    id: int,
    redis: Redis,
    *,
    request_id: str | None = None,
    queue_job_id: str | None = None,
) -> None:  # noqa: N802
    await redis.enqueue_job(
        "buildroot_sd_image",
        id=id,
        request_id=request_id,
        _job_id=queue_job_id,
    )


async def buildroot_sd_image_task(ctx: dict[str, Any], id: int, request_id: str | None = None):  # noqa: N802
    db: Session = ctx["db"]
    redis: Redis = ctx["redis"]
    frame: Optional[Frame] = get_fresh_frame(db, id)
    if frame is None:
        await log(db, redis, id, "stderr", "Frame not found")
        raise Exception("Frame not found")

    try:
        ensure_buildroot_frame_defaults(frame)
        if request_id and not _sd_image_request_matches(frame, request_id):
            await log(db, redis, id, "stderr", "Ignoring stale Buildroot SD image worker job")
            return
        builder = BuildrootImageBuilder(db=db, redis=redis, frame=frame, request_id=request_id)
        await builder.run()
    except Exception as exc:
        frame = get_fresh_frame(db, id) or frame
        if not request_id or _sd_image_request_matches(frame, request_id):
            current = latest_buildroot_sd_image(frame) or {}
            await _set_sd_image_status(
                db,
                redis,
                frame,
                {
                    **_preserved_queue_metadata(current),
                    "status": "error",
                    "platform": (frame.buildroot or {}).get("platform") or SUPPORTED_BUILDROOT_PLATFORM,
                    "error": str(exc),
                    "completedAt": _utc_now(),
                },
            )
        await log(db, redis, id, "stderr", f"Buildroot SD image generation failed: {exc}")
        raise


class BuildrootImageBuilder:
    def __init__(self, *, db: Session, redis: Redis, frame: Frame, request_id: str | None = None) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.request_id = request_id
        self.build_environment_provider: BuildEnvironmentProvider = "docker"
        self.build_executor_config: BuildHostConfig | ModalSandboxConfig | None = None
        self.executor: BuildExecutor | None = None
        self._last_sd_image_heartbeat_at: datetime | None = None

    async def run(self) -> dict[str, Any]:
        settings = _get_frame_settings(self.db, self.frame)
        provider = selected_build_environment_provider(settings)
        if self._should_customize_precompiled_sd_image_locally(provider):
            provider = "none"
            self.build_executor_config = None
        else:
            self.build_executor_config = self._selected_build_executor()
        self.build_environment_provider = provider
        if provider == "none" and not self._can_use_precompiled_sd_image():
            raise RuntimeError(
                buildroot_sd_image_no_build_environment_message(
                    "precompiled Buildroot SD image mode with no compiled scenes"
                )
            )
        ensure_build_executor_configured(provider, self.build_executor_config)

        executor = create_build_executor(
            self.build_executor_config,
            db=self.db,
            redis=self.redis,
            frame=self.frame,
            logger=self._log,
            workspace_prefix="frameos-buildroot-",
        )
        if self.build_executor_config:
            connection_action = (
                f"Connecting to {build_executor_display_name(self.build_executor_config)} for Buildroot SD image generation"
                if executor.connects_on_enter
                else (
                    f"Using {build_executor_display_name(self.build_executor_config)} for Buildroot SD image generation; "
                    "sandbox will be created when the build command starts"
                )
            )
            await self._log(
                "stdout",
                connection_action,
            )
        async with executor:
            self.executor = executor
            if self.build_executor_config and executor.connects_on_enter:
                await self._log(
                    "stdout",
                    f"Connected to {build_executor_display_name(self.build_executor_config)} for Buildroot SD image generation",
                )
            try:
                return await self._run_with_context()
            finally:
                self.executor = None

    async def _run_with_context(self) -> dict[str, Any]:
        validate_buildroot_wifi_credentials(self.frame)
        bootstrap_frame = self._buildroot_bootstrap_frame()
        setup_payload = _buildroot_setup_payload(self.db, self.frame)

        artifact_dir = buildroot_artifact_dir()
        cache_dir = buildroot_cache_dir()
        source_dir = buildroot_source_dir()
        output_cache_root = buildroot_output_cache_dir()
        artifact_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
        source_dir.mkdir(parents=True, exist_ok=True)
        output_cache_root.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix=f"frameos-buildroot-{self.frame.id}-") as tmp:
            temp_dir = Path(tmp)
            deployer = FrameDeployer(self.db, self.redis, self.frame, "", str(temp_dir))
            build_id = deployer.build_id
            raw_filename = f"frameos-{self.frame.id}-{SUPPORTED_BUILDROOT_PLATFORM}-{build_id}.img"
            filename = f"{raw_filename}.gz"
            raw_output_path = artifact_dir / raw_filename
            output_path = artifact_dir / filename

            started_at = _utc_now()
            await _set_sd_image_status(
                self.db,
                self.redis,
                self.frame,
                _with_optional_request_id({
                    **_preserved_queue_metadata(latest_buildroot_sd_image(self.frame) or {}),
                    "status": "building",
                    "buildId": build_id,
                    "platform": SUPPORTED_BUILDROOT_PLATFORM,
                    "frameosVersion": current_frameos_version(),
                    "filename": filename,
                    "rawFilename": raw_filename,
                    "compilationMode": frame_compilation_mode(self.frame),
                    "configFingerprint": buildroot_sd_image_config_fingerprint(self.frame),
                    "startedAt": started_at,
                    "lastHeartbeatAt": started_at,
                }, self.request_id),
            )
            await self._log("stdout", f"Starting Buildroot SD image build {build_id}")

            base_entry: dict[str, Any] | None = None
            compose_image = None
            precompiled_sd_image = None
            if self._can_use_precompiled_sd_image():
                compose_image = await self._precompiled_sd_image_patch_image()
                precompiled_sd_image = await self._try_compose_precompiled_sd_image(
                    temp_dir=temp_dir,
                    output_path=raw_output_path,
                    bootstrap_frame=bootstrap_frame,
                    setup_payload=setup_payload,
                    image=compose_image,
                    allow_fallback=self.build_environment_provider != "none",
                )
            if precompiled_sd_image is None and self.build_environment_provider == "none":
                raise RuntimeError(
                    buildroot_sd_image_no_build_environment_message(
                        "an available full precompiled Buildroot SD image release"
                    )
                )
            if precompiled_sd_image is None:
                base_entry = await resolve_buildroot_base_entry(SUPPORTED_BUILDROOT_PLATFORM)
                if compose_image is None:
                    compose_image = await self._compose_tools_image()
                frameos_build = await self._build_frameos_binary(deployer, str(temp_dir), self.frame)
                remote_binary = await self._build_remote_binary(deployer, str(temp_dir), self.frame)
                overlay_dir = temp_dir / "overlay"
                self._stage_overlay(
                    overlay_dir=overlay_dir,
                    build_id=build_id,
                    bootstrap_frame=bootstrap_frame,
                    setup_payload=setup_payload,
                    frameos_build=frameos_build,
                    remote_binary=remote_binary,
                )

                script_path = temp_dir / "buildroot-build.sh"
                config_path = temp_dir / "frameos-buildroot.config"
                post_build_path = temp_dir / "post-build.sh"
                partition_post_build_path = temp_dir / "partition-post-build.sh"
                post_image_path = temp_dir / "post-image.sh"
                kernel_fragment_path = temp_dir / "linux-fragment.config"
                self._write_buildroot_config(config_path)
                self._write_kernel_config_fragment(kernel_fragment_path)
                self._write_post_build_script(post_build_path)
                self._write_partition_post_build_script(partition_post_build_path)
                self._write_post_image_script(post_image_path)
                self._write_boot_logo(temp_dir / Path(BUILDROOT_BOOT_LOGO_WORK_PATH).name)
                base_image_path = await ensure_buildroot_base_image(base_entry, buildroot_base_cache_dir())
                await self._compose_sd_image_from_base(
                    temp_dir=temp_dir,
                    base_image_path=base_image_path,
                    output_path=raw_output_path,
                    image=compose_image,
                )

            if not raw_output_path.is_file():
                raise RuntimeError(f"SD image composer completed without producing {raw_output_path.name}")

            raw_size = raw_output_path.stat().st_size
            raw_sha256 = await self._with_progress_updates(
                "Still checksumming raw Buildroot SD image",
                asyncio.to_thread(_sha256, raw_output_path),
            )
            await self._with_progress_updates(
                "Still compressing Buildroot SD image",
                asyncio.to_thread(_gzip_file, raw_output_path, output_path),
            )
            raw_output_path.unlink(missing_ok=True)
            compressed_sha256 = await self._with_progress_updates(
                "Still checksumming compressed Buildroot SD image",
                asyncio.to_thread(_sha256, output_path),
            )

            metadata = {
                **_preserved_queue_metadata(latest_buildroot_sd_image(self.frame) or {}),
                "status": "ready",
                "buildId": build_id,
                "platform": SUPPORTED_BUILDROOT_PLATFORM,
                "frameosVersion": current_frameos_version(),
                "buildrootVersion": BUILDROOT_VERSION,
                **(
                    {
                        "baseImage": {
                            "frameosVersion": base_entry.get("frameos_version"),
                            "objectKey": base_entry.get("object_key"),
                            "sha256": base_entry.get("sha256"),
                            "updatedAt": base_entry.get("updated_at"),
                        },
                    }
                    if base_entry is not None
                    else {}
                ),
                **(
                    {
                        "precompiledSdImage": {
                            "releaseUrl": precompiled_sd_image.release_url,
                            "cacheHit": precompiled_sd_image.cache_hit,
                        },
                    }
                    if precompiled_sd_image is not None
                    else {}
                ),
                "filename": filename,
                "rawFilename": raw_filename,
                "path": str(output_path),
                "compressed": True,
                "customizationVersion": BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION,
                "compilationMode": frame_compilation_mode(self.frame),
                "configFingerprint": buildroot_sd_image_config_fingerprint(self.frame),
                "rawSize": raw_size,
                "rawSha256": raw_sha256,
                "size": output_path.stat().st_size,
                "sha256": compressed_sha256,
                "downloadUrl": f"/api/projects/{self.frame.project_id}/frames/{self.frame.id}/buildroot/sd_image/download",
                "createdAt": _utc_now(),
                "completedAt": _utc_now(),
            }
            await _set_sd_image_status(self.db, self.redis, self.frame, metadata)
            await self._log("stdout", f"Buildroot SD image ready, starting download, please wait for {filename}")
            return metadata

    def _can_use_precompiled_sd_image(self) -> bool:
        return can_use_precompiled_buildroot_sd_image(self.frame)

    def _should_customize_precompiled_sd_image_locally(self, provider: BuildEnvironmentProvider) -> bool:
        return bool(os.environ.get("HASSIO_RUN_MODE")) and provider != "none" and self._can_use_precompiled_sd_image()

    def _selected_build_executor(self) -> BuildHostConfig | ModalSandboxConfig | None:
        project_id = getattr(self.frame, "project_id", None)
        if self.db is None or project_id is None:
            return None
        return get_build_executor_config(self.db, project_id)

    async def _compose_tools_image(self) -> str | None:
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
        if not self.executor.uses_local_filesystem:
            return await self._ensure_buildroot_image()
        return None if self._host_has_compose_tools() else await self._ensure_buildroot_image()

    async def _run_command(
        self,
        command: str,
        *,
        log_command: str | bool = True,
        log_output: bool = True,
        stderr_log_tag: Literal["stderr", "stdout"] = "stderr",
    ) -> tuple[int, str | None, str | None]:
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
        return await self.executor.run(
            command,
            log_command=log_command,
            log_output=log_output,
            stderr_log_tag=stderr_log_tag,
        )

    async def _try_compose_precompiled_sd_image(
        self,
        *,
        temp_dir: Path,
        output_path: Path,
        bootstrap_frame: Frame | Any,
        setup_payload: dict[str, Any],
        image: str | None,
        allow_fallback: bool = True,
    ) -> PrecompiledBuildrootSdImageResult | None:
        if not self._can_use_precompiled_sd_image():
            return None

        precompiled_sd_image = await download_precompiled_buildroot_sd_image(
            platform=SUPPORTED_BUILDROOT_PLATFORM,
            logger=self._log,
        )
        if precompiled_sd_image is None:
            await self._log("stdout", "Falling back to composing SD image from cached Buildroot base")
            return None

        overlay_dir = temp_dir / "overlay"
        self._stage_boot_overlay(
            overlay_dir=overlay_dir,
            bootstrap_frame=bootstrap_frame,
            setup_payload=setup_payload,
        )
        try:
            await self._compose_sd_image_from_precompiled_release(
                temp_dir=temp_dir,
                release_image_path=precompiled_sd_image.archive_path,
                output_path=output_path,
                image=image,
            )
        except Exception as exc:
            output_path.unlink(missing_ok=True)
            if not allow_fallback:
                raise RuntimeError(f"Could not customize full precompiled Buildroot SD image release: {exc}") from exc
            await self._log(
                "stderr",
                f"Could not use full precompiled Buildroot SD image release: {exc}. Falling back to composed image.",
            )
            return None
        return precompiled_sd_image

    async def _build_frameos_binary(
        self,
        deployer: FrameDeployer,
        temp_dir: str,
        frame: Frame,
    ) -> FrameBinaryBuildResult:
        await self._log("stdout", "Building FrameOS binary for Raspberry Pi Zero 2 W")
        builder = FrameBinaryBuilder(
            db=self.db,
            redis=self.redis,
            frame=frame,
            deployer=deployer,
            temp_dir=temp_dir,
        )
        plan = await builder.plan_build(
            force_cross_compile=False,
            allow_on_device_fallback=False,
            target_override=FRAMEOS_BUILD_TARGET,
            compilation_mode=frame_compilation_mode(frame),
        )
        return await builder.build(plan, precompiled_install_all_drivers=True)

    async def _build_remote_binary(self, deployer: FrameDeployer, temp_dir: str, frame: Frame) -> str:
        await self._log("stdout", "Building FrameOS Remote for Raspberry Pi Zero 2 W")
        prebuilt_target = resolve_prebuilt_target(
            FRAMEOS_BUILD_TARGET.distro,
            FRAMEOS_BUILD_TARGET.version,
            FRAMEOS_BUILD_TARGET.arch,
        )
        if prebuilt_target:
            try:
                result = await download_precompiled_remote_release(
                    target=prebuilt_target,
                    build_dir=str(Path(temp_dir) / f"remote_{deployer.build_id}"),
                    temp_dir=temp_dir,
                    build_id=deployer.build_id,
                    logger=self._log,
                )
                action = "Using cached" if result.cache_hit else "Downloaded"
                await self._log("stdout", f"{action} precompiled FrameOS Remote release: {result.release_url}")
                return result.binary_path
            except Exception as exc:
                await self._log(
                    "stderr",
                    f"Could not use precompiled FrameOS Remote for {prebuilt_target}: {exc}. Falling back to source build.",
                )

        remote_deployer = RemoteDeployer(self.db, self.redis, frame, "", temp_dir, force_source=True)
        remote_deployer.build_id = deployer.build_id
        build_dir, source_dir = remote_deployer._create_remote_build_folders()
        await remote_deployer._create_local_build_archive(build_dir, source_dir, FRAMEOS_BUILD_TARGET.arch)
        return await CrossCompiler(
            db=self.db,
            redis=self.redis,
            frame=frame,
            deployer=remote_deployer,
            target=FRAMEOS_BUILD_TARGET,
            temp_dir=temp_dir,
            build_dir=build_dir,
            logger=remote_deployer.log,
            output_name="frameos_remote",
            compile_script_name="compile_frameos_remote.sh",
            needs_quickjs=False,
            build_host=self.build_executor_config,
        ).build(source_dir)

    def _stage_overlay(
        self,
        *,
        overlay_dir: Path,
        build_id: str,
        bootstrap_frame: Frame | Any,
        setup_payload: dict[str, Any],
        frameos_build: FrameBinaryBuildResult,
        remote_binary: str,
    ) -> None:
        release_dir = overlay_dir / "srv" / "frameos" / "releases" / f"release_{build_id}"
        remote_release_dir = overlay_dir / "srv" / "frameos" / "remote" / "releases" / f"release_{build_id}"
        state_dir = overlay_dir / "srv" / "frameos" / "state"
        boot_overlay_dir = overlay_dir / "boot"
        assets_dir = overlay_dir / "srv" / "assets"
        systemd_dir = overlay_dir / "etc" / "systemd" / "system"
        wants_dir = systemd_dir / "multi-user.target.wants"

        for directory in (
            release_dir,
            remote_release_dir,
            state_dir,
            assets_dir,
            boot_overlay_dir,
            wants_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        if not frameos_build.binary_path:
            raise RuntimeError("FrameOS cross compilation did not produce a binary")
        shutil.copy2(frameos_build.binary_path, release_dir / "frameos")
        os.chmod(release_dir / "frameos", 0o755)
        self._copy_libraries(frameos_build.driver_library_paths, release_dir / "drivers")
        self._copy_libraries(frameos_build.scene_library_paths, release_dir / "scenes")

        (release_dir / "frame.json").write_text(
            json.dumps(get_frame_json(self.db, bootstrap_frame), indent=4) + "\n",
            encoding="utf-8",
        )
        (release_dir / "scenes.json.gz").write_bytes(
            gzip.compress(
                json.dumps(get_interpreted_scenes_json(self.frame), indent=4).encode("utf-8") + b"\n",
                mtime=0,
            )
        )
        (release_dir / "all_scenes.json.gz").write_bytes(
            gzip.compress(
                json.dumps(list(getattr(self.frame, "scenes", []) or []), indent=4).encode("utf-8") + b"\n",
                mtime=0,
            )
        )
        # No console_output: frameos draws to the framebuffer on the same VT,
        # so mirroring its logs to tty1 would scribble over the rendered image.
        self._write_service(
            REPO_ROOT / "frameos" / "frameos.service",
            release_dir / "frameos.service",
            user="root",
            environment={
                "FRAMEOS_HOME": "/srv/frameos/current",
                "LD_LIBRARY_PATH": "/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib",
            },
        )

        shutil.copy2(remote_binary, remote_release_dir / "frameos_remote")
        os.chmod(remote_release_dir / "frameos_remote", 0o755)
        (remote_release_dir / "frame.json").write_text(
            json.dumps(get_frame_json(self.db, bootstrap_frame), indent=4) + "\n",
            encoding="utf-8",
        )
        self._write_service(
            REPO_ROOT / "frameos" / "remote" / "frameos-remote.service",
            remote_release_dir / "frameos-remote.service",
            user="root",
            environment={
                "FRAMEOS_HOME": "/srv/frameos/current",
                "LD_LIBRARY_PATH": "/usr/lib:/usr/local/lib",
            },
        )

        self._relative_symlink(f"releases/release_{build_id}", overlay_dir / "srv" / "frameos" / "current")
        self._relative_symlink(
            f"releases/release_{build_id}",
            overlay_dir / "srv" / "frameos" / "remote" / "current",
        )
        self._relative_symlink("/srv/frameos/state", release_dir / "state")
        self._stage_font_assets(assets_dir)

        self._stage_boot_overlay(
            overlay_dir=overlay_dir,
            bootstrap_frame=bootstrap_frame,
            setup_payload=setup_payload,
        )

    def _stage_boot_overlay(
        self,
        *,
        overlay_dir: Path,
        bootstrap_frame: Frame | Any,
        setup_payload: dict[str, Any],
    ) -> None:
        boot_overlay_dir = overlay_dir / "boot"
        systemd_dir = overlay_dir / "etc" / "systemd" / "system"
        wants_dir = systemd_dir / "multi-user.target.wants"
        boot_overlay_dir.mkdir(parents=True, exist_ok=True)

        setup_reset_enabled = setup_json_reset_enabled(self.frame)
        if setup_reset_enabled:
            setup_file_path = setup_json_reset_file_path(self.frame, default_if_missing=True)
            self._write_setup_payload(_boot_setup_payload_path(boot_overlay_dir, setup_file_path), setup_payload)
            script_path = overlay_dir / SETUP_JSON_RESET_SCRIPT_PATH.lstrip("/")
            script_path.parent.mkdir(parents=True, exist_ok=True)
            wants_dir.mkdir(parents=True, exist_ok=True)
            script_path.write_text(render_setup_json_reset_script(setup_file_path), encoding="utf-8")
            os.chmod(script_path, 0o755)
            (systemd_dir / SETUP_JSON_RESET_SERVICE_NAME).write_text(
                render_setup_json_reset_service(
                    setup_file_path,
                    script_path=SETUP_JSON_RESET_SCRIPT_PATH,
                ),
                encoding="utf-8",
            )
            self._relative_symlink(
                f"../{SETUP_JSON_RESET_SERVICE_NAME}",
                wants_dir / SETUP_JSON_RESET_SERVICE_NAME,
            )

        (boot_overlay_dir / Path(BOOT_HOSTNAME_FILE).name).write_text(_hostname_for_frame(self.frame) + "\n", encoding="utf-8")
        self._write_boot_wifi_connection(boot_overlay_dir / Path(BOOT_WIFI_CONNECTION_FILE).name)
        self._write_boot_config(overlay_dir, _frame_boot_config_lines(bootstrap_frame))
        self._write_boot_authorized_keys(boot_overlay_dir / Path(BOOT_AUTHORIZED_KEYS_FILE).name)
        self._write_boot_root_password(boot_overlay_dir / Path(BOOT_ROOT_PASSWORD_FILE).name)

    def _stage_font_assets(self, assets_dir: Path) -> None:
        if getattr(self.frame, "upload_fonts", "") == "none":
            return

        fonts_dir = assets_dir / "fonts"
        if BUILDROOT_LOCAL_FONTS_DIR.is_dir():
            for source_path in BUILDROOT_LOCAL_FONTS_DIR.rglob("*"):
                if not source_path.is_file() or source_path.suffix not in BUILDROOT_LOCAL_FONT_EXTENSIONS:
                    continue
                target_path = fonts_dir / source_path.relative_to(BUILDROOT_LOCAL_FONTS_DIR)
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)

        if self.db is None or not hasattr(self.db, "query") or not hasattr(self.frame, "project_id"):
            return

        custom_fonts = self.db.query(Assets).filter(
            Assets.project_id == self.frame.project_id,
            Assets.path.like("fonts/%.ttf"),
        ).all()
        for font in custom_fonts:
            relative_path = Path(str(font.path).removeprefix("fonts/"))
            if relative_path.is_absolute() or any(part in ("", ".", "..") for part in relative_path.parts):
                continue
            target_path = fonts_dir / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_bytes(font.data or b"")

    @staticmethod
    def _copy_libraries(paths: list[str], destination: Path) -> None:
        if not paths:
            return
        destination.mkdir(parents=True, exist_ok=True)
        for path in paths:
            shutil.copy2(path, destination / Path(path).name)

    @staticmethod
    def _write_service(
        source: Path,
        destination: Path,
        *,
        user: str,
        console_output: bool = False,
        environment: dict[str, str] | None = None,
    ) -> None:
        destination.write_text(
            render_systemd_service(
                source,
                user=user,
                console_output=console_output,
                environment=environment,
            ),
            encoding="utf-8",
        )

    def _write_boot_authorized_keys(self, authorized_keys: Path) -> None:
        settings = _get_frame_settings(self.db, self.frame)
        selected_keys = select_ssh_keys_for_frame(self.frame, settings)
        public_keys = [
            key["public"].strip()
            for key in selected_keys
            if isinstance(key.get("public"), str) and key.get("public", "").strip()
        ]
        if not public_keys:
            return
        authorized_keys.parent.mkdir(parents=True, exist_ok=True)
        authorized_keys.write_text("\n".join(dict.fromkeys(public_keys)) + "\n", encoding="utf-8")
        os.chmod(authorized_keys, 0o600)

    def _write_boot_root_password(self, root_password_file: Path) -> None:
        password = getattr(self.frame, "ssh_pass", None)
        if password is None:
            return
        password = str(password)
        if not password:
            root_password_file.unlink(missing_ok=True)
            return
        if "\n" in password or "\r" in password:
            raise ValueError("Root user password cannot contain line breaks")
        root_password_file.parent.mkdir(parents=True, exist_ok=True)
        root_password_file.write_text(password, encoding="utf-8")
        os.chmod(root_password_file, 0o600)

    def _write_boot_wifi_connection(self, path: Path) -> None:
        ssid, password = validate_buildroot_wifi_credentials(self.frame)
        if not ssid:
            path.unlink(missing_ok=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_network_manager_wifi_connection(ssid, password), encoding="utf-8")
        os.chmod(path, 0o600)

    @staticmethod
    def _relative_symlink(target: str, link: Path) -> None:
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(target)

    @staticmethod
    def _write_buildroot_config(path: Path) -> None:
        path.write_text(
            "\n".join(
                [
                    "BR2_INIT_SYSTEMD=y",
                    "BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV=y",
                    "BR2_ENABLE_LOCALE=y",
                    "BR2_SYSTEM_DHCP=\"eth0\"",
                    "BR2_TARGET_GENERIC_HOSTNAME=\"frameos\"",
                    "BR2_TARGET_GENERIC_ISSUE=\"Welcome to FrameOS\"",
                    "BR2_TARGET_ROOTFS_EXT2_SIZE=\"768M\"",
                    f"BR2_JLEVEL={BUILDROOT_JLEVEL}",
                    'BR2_DL_DIR="/cache/dl"',
                    'BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES="/work/linux-fragment.config"',
                    f'BR2_LINUX_KERNEL_CUSTOM_LOGO_PATH="{BUILDROOT_BOOT_LOGO_WORK_PATH}"',
                    "BR2_PACKAGE_SYSTEMD=y",
                    "BR2_PACKAGE_SYSTEMD_TIMESYNCD=y",
                    "BR2_PACKAGE_DBUS=y",
                    "BR2_PACKAGE_DROPBEAR=y",
                    "BR2_PACKAGE_DCRON=y",
                    "BR2_PACKAGE_SHADOW=y",
                    "BR2_PACKAGE_SUDO=y",
                    "BR2_PACKAGE_CA_CERTIFICATES=y",
                    "BR2_PACKAGE_TZDATA=y",
                    "BR2_PACKAGE_BASH=y",
                    "BR2_PACKAGE_COREUTILS=y",
                    "BR2_PACKAGE_FINDUTILS=y",
                    "BR2_PACKAGE_GZIP=y",
                    "BR2_PACKAGE_TAR=y",
                    "BR2_PACKAGE_UTIL_LINUX=y",
                    "BR2_PACKAGE_UTIL_LINUX_BINARIES=y",
                    "BR2_PACKAGE_UTIL_LINUX_PARTX=y",
                    "BR2_PACKAGE_E2FSPROGS=y",
                    "BR2_PACKAGE_E2FSPROGS_RESIZE2FS=y",
                    "BR2_PACKAGE_DOSFSTOOLS=y",
                    "BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT=y",
                    "BR2_PACKAGE_NANO=y",
                    "BR2_PACKAGE_IPROUTE2=y",
                    "BR2_PACKAGE_KMOD=y",
                    "BR2_PACKAGE_OPENSSL=y",
                    "BR2_PACKAGE_ZLIB=y",
                    "BR2_PACKAGE_FFMPEG=y",
                    "BR2_PACKAGE_FFMPEG_FFPROBE=y",
                    "BR2_PACKAGE_FFMPEG_SWSCALE=y",
                    "BR2_PACKAGE_HOSTAPD=y",
                    "BR2_PACKAGE_DNSMASQ=y",
                    "BR2_PACKAGE_NETWORK_MANAGER=y",
                    "BR2_PACKAGE_NETWORK_MANAGER_CLI=y",
                    "BR2_PACKAGE_NETWORK_MANAGER_WIFI=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT_DBUS=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT_AP_SUPPORT=y",
                    "BR2_PACKAGE_IW=y",
                    "BR2_PACKAGE_WIRELESS_TOOLS=y",
                    "BR2_PACKAGE_WIRELESS_REGDB=y",
                    "BR2_PACKAGE_LINUX_FIRMWARE=y",
                    "BR2_PACKAGE_LINUX_FIRMWARE_BRCM_BCM43XXX=y",
                    "BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI=y",
                    "BR2_PACKAGE_LIBEVDEV=y",
                    "# BR2_CCACHE is not set",
                    'BR2_ROOTFS_OVERLAY="/work/overlay"',
                    'BR2_ROOTFS_POST_BUILD_SCRIPT="board/raspberrypi/post-build.sh /work/post-build.sh /work/partition-post-build.sh"',
                    'BR2_ROOTFS_POST_IMAGE_SCRIPT="/work/post-image.sh"',
                    "",
                ]
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _write_kernel_config_fragment(path: Path) -> None:
        path.write_text(
            "\n".join(
                [
                    "# Avoid case-colliding xtables target/match objects on macOS bind mounts.",
                    "# CONFIG_NETFILTER_XT_TARGET_DSCP is not set",
                    "# CONFIG_NETFILTER_XT_TARGET_HL is not set",
                    "# CONFIG_NETFILTER_XT_TARGET_RATEEST is not set",
                    "# CONFIG_NETFILTER_XT_TARGET_TCPMSS is not set",
                    "# CONFIG_NETFILTER_XT_MATCH_RATEEST is not set",
                    "# CONFIG_IP_NF_TARGET_ECN is not set",
                    "# CONFIG_IP_NF_TARGET_TTL is not set",
                    "# CONFIG_IP6_NF_TARGET_HL is not set",
                    "",
                    "# Trimmed for Raspberry Pi Zero 2 W use cases.",
                    "# Keep HID, HDMI, Wi-Fi, Bluetooth and USB storage; trim the rest.",
                    "# Telephony/streaming/media/input-complexity reducers.",
                    "# CONFIG_AUXDISPLAY is not set",
                    "# CONFIG_CAN is not set",
                    "# CONFIG_DVB_CORE is not set",
                    "# CONFIG_DVB_USB is not set",
                    "# CONFIG_HAMRADIO is not set",
                    "# CONFIG_MEDIA_DIGITAL_TV_SUPPORT is not set",
                    "# CONFIG_MEDIA_PCI_SUPPORT is not set",
                    "# CONFIG_MEDIA_PLATFORM_DRIVERS is not set",
                    "# CONFIG_MEDIA_USB_SUPPORT is not set",
                    "# CONFIG_STAGING is not set",
                    "# CONFIG_VIDEO_DEV is not set",
                    "# CONFIG_VIDEO_HDPVR is not set",
                    "# CONFIG_VIDEO_OV2640 is not set",
                    "# CONFIG_USB_ACM is not set",
                    "# CONFIG_USB_NET_AX88179_178A is not set",
                    "# CONFIG_USB_NET_CDCETHER is not set",
                    "# CONFIG_USB_NET_CDC_SUBSET is not set",
                    "# CONFIG_USB_NET_CDC_NCM is not set",
                    "# CONFIG_USB_NET_CDC_MBIM is not set",
                    "# CONFIG_USB_NET_DM9601 is not set",
                    "# CONFIG_USB_NET_CDC_EEM is not set",
                    "# CONFIG_USB_NET_HUAWEI_CDC_NCM is not set",
                    "# CONFIG_USB_NET_RNDIS_HOST is not set",
                    "# CONFIG_USB_OHCI_HCD_PLATFORM is not set",
                    "# CONFIG_USB_PRINTER is not set",
                    "# CONFIG_USB_ROLE_SWITCH is not set",
                    "# CONFIG_USB_SERIAL is not set",
                    "# CONFIG_USB_MON is not set",
                    "# CONFIG_WIMAX is not set",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _write_boot_config(overlay_dir: Path, boot_config_lines: list[str]) -> None:
        if not boot_config_lines:
            return

        requested_lines = [line.strip() for line in boot_config_lines if line.strip()]
        if not requested_lines:
            return

        boot_files = [overlay_dir / "boot" / "config.txt"]
        for boot_file in boot_files:
            current = boot_file.read_text(encoding="utf-8") if boot_file.is_file() else ""
            merged = _merge_boot_config_lines(current, requested_lines)
            if merged == current:
                continue
            boot_file.parent.mkdir(parents=True, exist_ok=True)
            boot_file.write_text(merged, encoding="utf-8")

    @staticmethod
    def _write_post_build_script(path: Path) -> None:
        path.write_text(POST_BUILD_SCRIPT, encoding="utf-8")
        os.chmod(path, 0o755)

    @staticmethod
    def _write_partition_post_build_script(path: Path) -> None:
        path.write_text(PARTITION_POST_BUILD_SCRIPT, encoding="utf-8")
        os.chmod(path, 0o755)

    @staticmethod
    def _write_post_image_script(path: Path) -> None:
        path.write_text(POST_IMAGE_SCRIPT, encoding="utf-8")
        os.chmod(path, 0o755)

    @staticmethod
    def _write_boot_logo(path: Path) -> None:
        if not BUILDROOT_BOOT_LOGO_SOURCE.is_file():
            raise RuntimeError(f"Buildroot boot logo is missing; expected at {BUILDROOT_BOOT_LOGO_SOURCE}")
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BUILDROOT_BOOT_LOGO_SOURCE, path)

    @staticmethod
    def _write_setup_payload(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        encoded = (json.dumps(payload, indent=4) + "\n").encode("utf-8")
        if path.name.endswith(".gz"):
            path.write_bytes(gzip.compress(encoded, mtime=0))
        else:
            path.write_bytes(encoded)

    def _buildroot_bootstrap_frame(self) -> Frame | Any:
        bootstrap_data = copy.deepcopy(self.frame.to_dict())
        bootstrap_data["mode"] = "buildroot"
        bootstrap_data["device"] = "web_only"
        bootstrap_data["scenes"] = []
        bootstrap_data["gpio_buttons"] = []
        bootstrap_data["schedule"] = None
        buildroot = dict(bootstrap_data.get("buildroot") or {})
        buildroot.pop("sdImage", None)
        buildroot["platform"] = normalize_buildroot_platform(buildroot.get("platform"))
        bootstrap_data["buildroot"] = buildroot
        return SimpleNamespace(**bootstrap_data)

    @staticmethod
    def _write_build_script(path: Path, output_filename: str) -> None:
        tarball = f"buildroot-{BUILDROOT_VERSION}.tar.gz"
        path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail

ulimit -n {BUILDROOT_DOCKER_NOFILE_LIMIT} || true

export DEBIAN_FRONTEND=noninteractive
export CC="/usr/bin/gcc"
export CXX="/usr/bin/g++"
export FC="/usr/bin/gfortran"
export HOSTCC="/usr/bin/gcc"
export HOSTCXX="/usr/bin/g++"
export HOSTFC="/usr/bin/gfortran"
export CFLAGS="{BUILDROOT_HOST_CFLAGS}"
export CXXFLAGS="{BUILDROOT_HOST_CXXFLAGS}"
export HOSTCXXFLAGS="{BUILDROOT_HOST_CXXFLAGS}"
unset TERMINFO TERMINFO_DIRS

if [ "${{BUILDROOT_SKIP_APT_INSTALL:-0}}" != "1" ]; then
  apt-get update
  apt-get install -y --no-install-recommends \\
    {BUILDROOT_DOCKER_APT_DEPS_LINE}
fi

mkdir -p /cache /work /artifacts /build/buildroot /build/output
source_tarball="/frameos-buildroot/{tarball}"
cache_tarball="/cache/{tarball}"
if [ ! -f /build/buildroot/.frameos-buildroot-version ]; then
  if [ -f "$source_tarball" ]; then
    tarball_path="$source_tarball"
  else
    if [ ! -f "$cache_tarball" ]; then
      curl -fsSL -o "$cache_tarball" https://buildroot.org/downloads/{tarball}
    fi
    tarball_path="$cache_tarball"
  fi
  tar -C /build/buildroot --strip-components=1 -xzf "$tarball_path"
  printf '%s\\n' '{BUILDROOT_VERSION}' > /build/buildroot/.frameos-buildroot-version
fi
ncurses_mk="/build/buildroot/package/ncurses/ncurses.mk"
if [ -f "$ncurses_mk" ] && ! grep -q "FRAMEOS_NCURSES_TERMINFO_LINKS" "$ncurses_mk"; then
  cat >> "$ncurses_mk" <<'EOF'

define FRAMEOS_NCURSES_TERMINFO_LINKS
	for dir in a d f l p s v x; do \
		hex=$$(printf '%02x' "'$$dir"); \
		if [ ! -e "$(STAGING_DIR)/usr/share/terminfo/$$dir" ] && [ -d "$(STAGING_DIR)/usr/share/terminfo/$$hex" ]; then \
			ln -s "$$hex" "$(STAGING_DIR)/usr/share/terminfo/$$dir"; \
		fi; \
	done
endef
NCURSES_POST_INSTALL_STAGING_HOOKS += FRAMEOS_NCURSES_TERMINFO_LINKS
EOF
fi
cmake_mk="/build/buildroot/package/cmake/cmake.mk"
if [ -f "$cmake_mk" ] && ! grep -q "FRAMEOS_CMAKE_CLOCK_SKEW_FEATURE_CACHE" "$cmake_mk"; then
  python3 - "$cmake_mk" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = "# FRAMEOS_CMAKE_CLOCK_SKEW_FEATURE_CACHE\\n"
needle = "\\t\\t\\t-DBUILD_CursesDialog=OFF \\\\\\n"
replacement = (
    "\\t\\t\\t-DBUILD_CursesDialog=OFF \\\\\\n"
    "\\t\\t\\t-DCMake_HAVE_CXX_MAKE_UNIQUE:INTERNAL=ON \\\\\\n"
    "\\t\\t\\t-DCMake_HAVE_CXX_UNIQUE_PTR:INTERNAL=ON \\\\\\n"
    "\\t\\t\\t-DCMake_HAVE_CXX_FILESYSTEM:INTERNAL=ON \\\\\\n"
)
if needle not in text:
    raise SystemExit("Could not patch host-cmake feature cache in %s" % path)
path.write_text(text.replace(needle, replacement, 1) + marker)
PY
fi
if [ "${{FRAMEOS_BUILDROOT_CLEAN:-0}}" = "1" ] && [ -f /build/output/Makefile ]; then
  make -C /build/buildroot O=/build/output clean
fi
if [ -s /build/output/images/sdcard.img ]; then
  cp /build/output/images/sdcard.img /artifacts/{shlex.quote(output_filename)}
  chmod a+r /artifacts/{shlex.quote(output_filename)}
  exit 0
fi
if compgen -G "/build/output/build/ncurses-*/.stamp_staging_installed" >/dev/null \\
  && ! find /build/output/host -path "*/sysroot/usr/share/terminfo/a/ansi" -print -quit | grep -q .; then
  for stamp in /build/output/build/ncurses-*/.stamp_staging_installed; do
    ncurses_dir="$(dirname "$stamp")"
    rm -f "$ncurses_dir/.stamp_staging_installed" "$ncurses_dir/.stamp_target_installed"
  done
fi
make -C /build/buildroot O=/build/output {BUILDROOT_DEFCONFIG}
cat /work/frameos-buildroot.config >> /build/output/.config
make -C /build/buildroot O=/build/output olddefconfig
rm -f /build/output/build/linux-custom/.stamp_configured
make -C /build/buildroot O=/build/output
dd if=/build/output/images/sdcard.img of=/artifacts/{shlex.quote(output_filename)} bs=4M conv=fsync status=none
chmod a+r /artifacts/{shlex.quote(output_filename)}
""",
            encoding="utf-8",
        )
        os.chmod(path, 0o755)

    async def _run_buildroot(
        self,
        temp_dir: Path,
        artifact_dir: Path,
        cache_dir: Path,
        source_dir: Path,
        output_dir: Path,
        image: str,
        skip_apt_install: bool,
    ) -> None:
        await self._log("stdout", f"Running Buildroot {BUILDROOT_VERSION} for Raspberry Pi Zero 2 W")
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
        status, _, err = await self._with_progress_updates(
            "Still running Buildroot image build",
            self.executor.docker_run(
                image=image,
                mounts=[
                    DockerMount(temp_dir, "/work"),
                    DockerMount(source_dir, "/build/buildroot"),
                    DockerMount(output_dir, "/build/output"),
                    DockerMount(cache_dir, "/cache"),
                    DockerMount(artifact_dir, "/artifacts"),
                ],
                env={
                    **({"BUILDROOT_SKIP_APT_INSTALL": "1"} if skip_apt_install else {}),
                    "FORCE_UNSAFE_CONFIGURE": "1",
                },
                ulimits=[f"nofile={BUILDROOT_DOCKER_NOFILE_LIMIT}:{BUILDROOT_DOCKER_NOFILE_LIMIT}"],
                args=["bash", "/work/buildroot-build.sh"],
                workspace="buildroot-image",
                log_command="docker run (buildroot image)",
            ),
        )
        if status != 0:
            raise RuntimeError(f"Buildroot image build failed: {err or 'see logs'}")

    async def _compose_sd_image_from_base(
        self,
        *,
        temp_dir: Path,
        base_image_path: Path,
        output_path: Path,
        image: str | None,
    ) -> None:
        await self._log("stdout", f"Composing SD image from cached Buildroot base {base_image_path.name}")
        compose_dir = temp_dir / "compose"
        compose_dir.mkdir(parents=True, exist_ok=True)
        images_dir = compose_dir / "images"
        roots_dir = compose_dir / "roots"
        images_dir.mkdir(parents=True, exist_ok=True)
        roots_dir.mkdir(parents=True, exist_ok=True)

        frameos_root = roots_dir / "frameos"
        assets_root = roots_dir / "assets"
        boot_root = roots_dir / "boot"
        shutil.copytree(temp_dir / "overlay" / "srv" / "frameos", frameos_root, symlinks=True)
        shutil.copytree(temp_dir / "overlay" / "srv" / "assets", assets_root, symlinks=True)
        shutil.copytree(temp_dir / "overlay" / "boot", boot_root, symlinks=True)
        if not any(assets_root.iterdir()):
            (assets_root / "frameos-assets-placeholder").write_text("", encoding="utf-8")

        frameos_partition_size = _partition_size_for_root(
            frameos_root,
            minimum_size=BUILDROOT_FRAMEOS_PARTITION_SIZE,
        )
        assets_partition_size = _partition_size_for_root(
            assets_root,
            minimum_size=BUILDROOT_ASSETS_PARTITION_SIZE,
        )
        compose_roots = f"/tmp/frameos-compose-roots-{os.getpid()}-{secure_token(6)}"
        genimage_cfg = compose_dir / "frameos-genimage.cfg"
        genimage_cfg.write_text(
            f"""image frameos.ext4 {{
	ext4 {{
		use-mke2fs = true
		label = "FRAMEOS"
	}}
	srcpath = "{compose_roots}/frameos"
	size = {frameos_partition_size}
}}

image assets.vfat {{
	vfat {{
		label = "ASSETS"
	}}
	srcpath = "{compose_roots}/assets"
	size = {assets_partition_size}
}}
""",
            encoding="utf-8",
        )

        script_path = compose_dir / "compose-partitions.sh"
        script_path.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
work_dir="${FRAMEOS_COMPOSE_WORK_DIR:-/work}"
compose_roots="${FRAMEOS_COMPOSE_ROOTS:-__FRAMEOS_COMPOSE_ROOTS__}"
trap 'rm -rf "$compose_roots"' EXIT
if ! command -v genimage >/dev/null 2>&1 || ! command -v mkfs.vfat >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends genimage dosfstools e2fsprogs mtools
fi
rm -rf "$work_dir/tmp"
rm -rf "$compose_roots"
mkdir -p "$compose_roots"
tar -C "$work_dir/roots" -cf - frameos assets | tar -C "$compose_roots" -xf -
genimage --rootpath "$work_dir/empty-root" --tmppath "$work_dir/tmp" --inputpath "$work_dir/images" --outputpath "$work_dir/images" --config "$work_dir/frameos-genimage.cfg"
""".replace("__FRAMEOS_COMPOSE_ROOTS__", compose_roots),
            encoding="utf-8",
        )
        os.chmod(script_path, 0o755)
        (compose_dir / "empty-root").mkdir(exist_ok=True)

        if image:
            if self.executor is None:
                raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
            status, _, err = await self._with_progress_updates(
                "Still composing Buildroot SD image partitions",
                self.executor.docker_run(
                    image=image,
                    mounts=[DockerMount(compose_dir.resolve(), "/work")],
                    args=["bash", "/work/compose-partitions.sh"],
                    workspace="compose",
                    log_command="docker run (buildroot image composer)",
                    stderr_log_tag="stdout",
                ),
            )
        else:
            compose_cmd = " ".join(
                [
                    f"FRAMEOS_COMPOSE_WORK_DIR={shlex.quote(str(compose_dir))}",
                    f"FRAMEOS_COMPOSE_ROOTS={shlex.quote(compose_roots)}",
                    "bash",
                    shlex.quote(str(script_path)),
                ]
            )
            log_command = "buildroot image composer"
            status, _, err = await self._with_progress_updates(
                "Still composing Buildroot SD image partitions",
                self._run_command(
                    compose_cmd,
                    log_command=log_command,
                    stderr_log_tag="stdout",
                ),
            )
        if status != 0:
            raise RuntimeError(f"Buildroot image composition failed: {err or 'see logs'}")

        partitions = await self._with_progress_updates(
            "Still applying composed partitions to Buildroot SD image",
            asyncio.to_thread(
                self._apply_composed_partitions,
                base_image_path,
                output_path,
                images_dir / "frameos.ext4",
                images_dir / "assets.vfat",
            ),
        )
        await self._patch_root_partition(output_path, partitions, image=image)
        await self._patch_boot_partition(output_path, partitions, boot_root, image=image)

    @staticmethod
    def _apply_composed_partitions(
        base_image_path: Path,
        output_path: Path,
        frameos_image: Path,
        assets_image: Path,
    ) -> list[dict[str, int]]:
        shutil.copy2(base_image_path, output_path)
        partitions = _mbr_partitions(output_path)
        partitions = _shrink_data_partitions(
            output_path,
            partitions,
            frameos_image=frameos_image,
            assets_image=assets_image,
        )
        _replace_partition(output_path, partitions, 3, frameos_image)
        _replace_partition(output_path, partitions, 4, assets_image)
        return partitions

    async def _compose_sd_image_from_precompiled_release(
        self,
        *,
        temp_dir: Path,
        release_image_path: Path,
        output_path: Path,
        image: str | None,
    ) -> None:
        await self._log("stdout", f"Customizing full precompiled Buildroot SD image {release_image_path.name}")
        compose_dir = temp_dir / "precompiled-compose"
        roots_dir = compose_dir / "roots"
        boot_root = roots_dir / "boot"
        compose_dir.mkdir(parents=True, exist_ok=True)
        roots_dir.mkdir(parents=True, exist_ok=True)
        if boot_root.exists():
            shutil.rmtree(boot_root)
        shutil.copytree(temp_dir / "overlay" / "boot", boot_root, symlinks=True)

        partitions = await self._with_progress_updates(
            "Still customizing precompiled Buildroot SD image",
            asyncio.to_thread(
                self._prepare_precompiled_release_image,
                release_image_path,
                output_path,
            ),
        )
        await self._patch_root_partition(output_path, partitions, image=image)
        await self._patch_boot_partition(output_path, partitions, boot_root, image=image)

    @staticmethod
    def _prepare_precompiled_release_image(release_image_path: Path, output_path: Path) -> list[dict[str, int]]:
        if release_image_path.name.endswith(".gz"):
            _gunzip_file(release_image_path, output_path)
        else:
            shutil.copy2(release_image_path, output_path)

        partitions = _mbr_partitions(output_path)
        # Full release images already include their FRAMEOS and ASSETS payloads.
        # Release composition may grow those partitions beyond the minimum
        # defaults, and this path only patches BOOT files.
        return partitions

    async def _patch_root_partition(
        self,
        output_path: Path,
        partitions: list[dict[str, int]],
        *,
        image: str | None,
    ) -> None:
        if len(partitions) < 2:
            raise RuntimeError("Cannot patch root partition; SD image has fewer than two partitions")

        root_partition = partitions[1]
        compose_dir = output_path.parent / f".{output_path.stem}-root-patch"
        service_root = compose_dir / "root-service"
        if compose_dir.exists():
            shutil.rmtree(compose_dir)
        compose_dir.mkdir(parents=True, exist_ok=True)
        stage_buildroot_frameos_service(service_root)
        (service_root / "etc" / "hostname").write_text(_hostname_for_frame(self.frame) + "\n", encoding="utf-8")

        script_path = compose_dir / "patch-root.sh"
        script_path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
image_dir="${{FRAMEOS_IMAGE_DIR:-/image}}"
service_root="${{FRAMEOS_ROOT_SERVICE_ROOT:-/root-service}}"
if ! command -v debugfs >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends e2fsprogs
fi
disk="$image_dir"/{shlex.quote(output_path.name)}
rootfs="$(mktemp)"
cmds="$(mktemp)"
firmware_tmp="$(mktemp -d)"
cleanup_root_patch() {{
  rm -rf "$rootfs" "$cmds" "$firmware_tmp"
}}
trap cleanup_root_patch EXIT
python3 - "$disk" "$rootfs" {root_partition["start"]} {root_partition["size"]} <<'PY'
import sys

disk_path, rootfs_path, start, size = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
with open(disk_path, "rb") as disk, open(rootfs_path, "wb") as rootfs:
    disk.seek(start)
    remaining = size
    while remaining:
        chunk = disk.read(min(1024 * 1024, remaining))
        if not chunk:
            raise SystemExit("root partition ended unexpectedly")
        rootfs.write(chunk)
        remaining -= len(chunk)
PY
cat > "$cmds" <<EOF
mkdir /etc
mkdir /etc/systemd
mkdir /etc/systemd/system
mkdir /etc/systemd/system/multi-user.target.wants
rm /etc/systemd/system/frameos.service
write $service_root/etc/systemd/system/frameos.service /etc/systemd/system/frameos.service
rm /etc/systemd/system/multi-user.target.wants/frameos.service
symlink /etc/systemd/system/multi-user.target.wants/frameos.service ../frameos.service
rm /etc/hostname
write $service_root/etc/hostname /etc/hostname
EOF
if ! debugfs -R "stat /usr/lib/firmware/brcm/brcmfmac43436-sdio.bin" "$rootfs" >/dev/null 2>&1 || \
   ! debugfs -R "stat /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" "$rootfs" >/dev/null 2>&1; then
python3 - "$firmware_tmp" <<'PY'
import hashlib
import sys
import urllib.parse
import urllib.request
from pathlib import Path

destination = Path(sys.argv[1])
base_url = (
    "https://raw.githubusercontent.com/RPi-Distro/firmware-nonfree/"
    "c91cd2804cf7463aab913e7247c176049f16bbd6/debian/config/brcm80211/brcm"
)
firmware_files = [
    ("510a7dd1e056199b309425548ee0bd846993a1837ac7fa1e4d3e641f05a1327a", "brcmfmac43436-sdio.bin"),
    ("fce7cbb62ffa6a5a65ca97b13f6fbf28d06c02d986c2072d65bf72164755fc34", "brcmfmac43436-sdio.clm_blob"),
    ("4cda90facd8844cff60d80b34b24ecbae76adb9a62508a109461b8bf42b478d1", "brcmfmac43436-sdio.txt"),
    ("68b9bcc9855d91733cd44c21de4cb507c91b0d32d838c0696def5eb96c99e2de", "brcmfmac43436s-sdio.bin"),
    ("37a8b85a5a9742761101b764a07bc4d0c8b09f2e180eaea3b503a834277ad595", "brcmfmac43436s-sdio.txt"),
]
for expected_sha, name in firmware_files:
    url = f"{{base_url}}/{{urllib.parse.quote(name, safe='')}}"
    data = urllib.request.urlopen(url, timeout=60).read()
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != expected_sha:
        raise SystemExit(f"Checksum mismatch for {{name}}: {{actual_sha}}")
    (destination / name).write_bytes(data)
PY
cat >> "$cmds" <<EOF
mkdir /usr
mkdir /usr/lib
mkdir /usr/lib/firmware
mkdir /usr/lib/firmware/brcm
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.bin
write $firmware_tmp/brcmfmac43436-sdio.bin /usr/lib/firmware/brcm/brcmfmac43436-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.clm_blob
write $firmware_tmp/brcmfmac43436-sdio.clm_blob /usr/lib/firmware/brcm/brcmfmac43436-sdio.clm_blob
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.txt
write $firmware_tmp/brcmfmac43436-sdio.txt /usr/lib/firmware/brcm/brcmfmac43436-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.bin
write $firmware_tmp/brcmfmac43436s-sdio.bin /usr/lib/firmware/brcm/brcmfmac43436s-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.txt
write $firmware_tmp/brcmfmac43436s-sdio.txt /usr/lib/firmware/brcm/brcmfmac43436s-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.bin
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.clm_blob
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.clm_blob brcmfmac43436-sdio.clm_blob
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.txt
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.bin
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.clm_blob
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.clm_blob brcmfmac43436-sdio.clm_blob
rm /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.txt
symlink /usr/lib/firmware/brcm/brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.clm_blob
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.clm_blob brcmfmac43436-sdio.clm_blob
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.txt
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.bin
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.clm_blob
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.clm_blob brcmfmac43436-sdio.clm_blob
rm /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.txt
symlink /usr/lib/firmware/brcm/brcmfmac43436-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.bin
symlink /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436s-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.txt
symlink /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436s-sdio.txt
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.bin
symlink /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436s-sdio.bin
rm /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.txt
symlink /usr/lib/firmware/brcm/brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436s-sdio.txt
EOF
fi
debugfs -w -f "$cmds" "$rootfs"
python3 - "$disk" "$rootfs" {root_partition["start"]} <<'PY'
import sys

disk_path, rootfs_path, start = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(disk_path, "r+b") as disk, open(rootfs_path, "rb") as rootfs:
    disk.seek(start)
    while True:
        chunk = rootfs.read(1024 * 1024)
        if not chunk:
            break
        disk.write(chunk)
PY
""",
            encoding="utf-8",
        )
        os.chmod(script_path, 0o755)

        try:
            if image:
                if self.executor is None:
                    raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
                status, _, err = await self._with_progress_updates(
                    "Still patching Buildroot SD image root partition",
                    self.executor.docker_run(
                        image=image,
                        mounts=[
                            DockerMount(output_path.resolve(), f"/image/{output_path.name}"),
                            DockerMount(service_root.resolve(), "/root-service", read_only=True),
                            DockerMount(script_path.resolve(), "/patch-root.sh", read_only=True),
                        ],
                        args=["bash", "/patch-root.sh"],
                        workspace="root-patch",
                        log_command="docker run (buildroot root partition patch)",
                        stderr_log_tag="stdout",
                    ),
                )
            else:
                patch_cmd = " ".join(
                    [
                        f"FRAMEOS_IMAGE_DIR={shlex.quote(str(output_path.parent))}",
                        f"FRAMEOS_ROOT_SERVICE_ROOT={shlex.quote(str(service_root))}",
                        "bash",
                        shlex.quote(str(script_path)),
                    ]
                )
                status, _, err = await self._with_progress_updates(
                    "Still patching Buildroot SD image root partition",
                    self._run_command(
                        patch_cmd,
                        log_command="buildroot root partition patch",
                        stderr_log_tag="stdout",
                    ),
                )
            if status != 0:
                raise RuntimeError(f"Buildroot root partition patch failed: {err or 'see logs'}")
        finally:
            shutil.rmtree(compose_dir, ignore_errors=True)

    async def _patch_boot_partition(
        self,
        output_path: Path,
        partitions: list[dict[str, int]],
        boot_root: Path,
        *,
        image: str | None,
    ) -> None:
        if not partitions:
            raise RuntimeError("Cannot patch BOOT partition; SD image has no partitions")

        compose_dir = boot_root.parent.parent
        script_path = compose_dir / "patch-boot.sh"
        setup_file_path = setup_json_reset_file_path(self.frame, default_if_missing=True)
        setup_relpath = setup_file_path.lstrip("/")
        if setup_relpath.startswith("boot/"):
            setup_relpath = setup_relpath[len("boot/"):]
        managed_boot_files = sorted(
            {
                Path(BOOT_HOSTNAME_FILE).name,
                Path(BOOT_WIFI_CONNECTION_FILE).name,
                Path(BOOT_AUTHORIZED_KEYS_FILE).name,
                setup_relpath,
            }
        )
        managed_boot_files_shell = " ".join(shlex.quote(path) for path in managed_boot_files if path)
        script_path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
image_dir="${{FRAMEOS_IMAGE_DIR:-/image}}"
boot_root="${{FRAMEOS_BOOT_ROOT:-/boot-root}}"
if ! command -v mlabel >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends mtools
fi
disk="$image_dir"/{shlex.quote(output_path.name)}
offset={partitions[0]["start"]}
target="${{disk}}@@${{offset}}"
mlabel -i "$target" ::BOOT
managed_boot_files=({managed_boot_files_shell})
for relpath in "${{managed_boot_files[@]}}"; do
  if [ ! -e "$boot_root/$relpath" ]; then
    mdel -i "$target" "::${{relpath}}" 2>/dev/null || true
  fi
done
merge_config() {{
  relpath="$1"
  src="$boot_root/$relpath"
  if [ ! -f "$src" ]; then
    return 0
  fi

  existing="$(mktemp)"
  merged="$(mktemp)"
  cleanup_config_merge() {{
    rm -f "$existing" "$merged"
  }}
  trap cleanup_config_merge RETURN

  if ! mcopy -i "$target" "::${{relpath}}" "$existing" 2>/dev/null; then
    : > "$existing"
  fi

  python3 - "$existing" "$src" "$merged" <<'PY'
import sys

existing_path, overlay_path, merged_path = sys.argv[1:4]
gpu_keys = {{"gpu_mem", "gpu_mem_256", "gpu_mem_512", "gpu_mem_1024"}}

with open(existing_path, encoding="utf-8") as handle:
    lines = handle.read().splitlines()

with open(overlay_path, encoding="utf-8") as handle:
    requested = [line.strip() for line in handle.read().splitlines() if line.strip()]

for line in requested:
    if line.startswith("#"):
        removed_line = line[1:]
        lines = [existing for existing in lines if existing != removed_line]
        continue

    if line.split("=", 1)[0] == "gpu_mem":
        lines = [
            existing for existing in lines
            if existing == line or existing.split("=", 1)[0] not in gpu_keys
        ]
    if line in lines:
        continue
    lines = [existing for existing in lines if existing != f"#{{line}}"]
    lines.append(line)

with open(merged_path, "w", encoding="utf-8") as handle:
    handle.write("\\n".join(lines).strip() + "\\n")
PY

  dirname="$(dirname "$relpath")"
  if [ "$dirname" != "." ]; then
    mmd -i "$target" "::${{dirname}}" 2>/dev/null || true
  fi
  mcopy -i "$target" -o "$merged" "::${{relpath}}"
  trap - RETURN
  cleanup_config_merge
}}

merge_config "config.txt"
merge_config "firmware/config.txt"

if find "$boot_root" -mindepth 1 -print -quit | grep -q .; then
  cd "$boot_root"
  find . -mindepth 1 -maxdepth 1 ! -name config.txt ! -name firmware -exec mcopy -i "$target" -o -s {{}} :: \\;
  if [ -d firmware ]; then
    mmd -i "$target" ::firmware 2>/dev/null || true
    find firmware -mindepth 1 -maxdepth 1 ! -name config.txt -exec mcopy -i "$target" -o -s {{}} ::firmware/ \\;
  fi
fi
""",
            encoding="utf-8",
        )
        os.chmod(script_path, 0o755)

        if image:
            if self.executor is None:
                raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
            status, _, err = await self._with_progress_updates(
                "Still patching Buildroot SD image boot partition",
                self.executor.docker_run(
                    image=image,
                    mounts=[
                        DockerMount(output_path.resolve(), f"/image/{output_path.name}"),
                        DockerMount(boot_root.resolve(), "/boot-root"),
                        DockerMount(script_path.resolve(), "/patch-boot.sh", read_only=True),
                    ],
                    args=["bash", "/patch-boot.sh"],
                    workspace="boot-patch",
                    log_command="docker run (buildroot boot partition patch)",
                    stderr_log_tag="stdout",
                ),
            )
        else:
            patch_cmd = " ".join(
                [
                    f"FRAMEOS_IMAGE_DIR={shlex.quote(str(output_path.parent))}",
                    f"FRAMEOS_BOOT_ROOT={shlex.quote(str(boot_root))}",
                    "bash",
                    shlex.quote(str(script_path)),
                ]
            )
            log_command = "buildroot boot partition patch"
            status, _, err = await self._with_progress_updates(
                "Still patching Buildroot SD image boot partition",
                self._run_command(
                    patch_cmd,
                    log_command=log_command,
                    stderr_log_tag="stdout",
                ),
            )
        if status != 0:
            raise RuntimeError(f"Buildroot BOOT partition patch failed: {err or 'see logs'}")

    async def _log(self, type: str, line: str) -> None:
        await log(self.db, self.redis, int(self.frame.id), type, line)
        await self._heartbeat_sd_image()

    async def _heartbeat_sd_image(self) -> None:
        if self.db is None or self.redis is None:
            return
        now = datetime.now(timezone.utc)
        if (
            self._last_sd_image_heartbeat_at is not None
            and (now - self._last_sd_image_heartbeat_at).total_seconds() < BUILDROOT_IMAGE_HEARTBEAT_INTERVAL_SECONDS
        ):
            return

        current = latest_buildroot_sd_image(self.frame) or {}
        if current.get("status") not in ACTIVE_SD_IMAGE_STATUSES:
            return
        if self.request_id and current.get("requestId") != self.request_id:
            return

        self._last_sd_image_heartbeat_at = now
        await _set_sd_image_status(
            self.db,
            self.redis,
            self.frame,
            {
                **current,
                "lastHeartbeatAt": now.isoformat(),
            },
        )

    async def _with_progress_updates(self, message: str, awaitable: Awaitable[T]) -> T:
        interval = BUILDROOT_PROGRESS_LOG_INTERVAL_SECONDS
        if interval <= 0:
            return await awaitable

        async def progress_logger() -> None:
            elapsed = 0.0
            while True:
                await asyncio.sleep(interval)
                elapsed += interval
                await self._log("stdout", f"{message} ({self._format_elapsed(elapsed)} elapsed)")

        task = asyncio.create_task(progress_logger())
        try:
            return await awaitable
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    @staticmethod
    def _format_elapsed(seconds: float) -> str:
        total_seconds = max(1, int(round(seconds)))
        minutes, remainder = divmod(total_seconds, 60)
        if minutes:
            return f"{minutes}m {remainder:02d}s"
        return f"{remainder}s"

    @staticmethod
    def _sanitize(value: str) -> str:
        return SAFE_SEGMENT.sub("_", value or "unknown")

    def _buildroot_image(self) -> str:
        base = self._sanitize(BUILDROOT_DOCKER_IMAGE.replace("/", "_"))
        version = self._sanitize(BUILDROOT_VERSION)
        slug = f"{base}-{version}"
        if BUILDROOT_IMAGE:
            try:
                return BUILDROOT_IMAGE.format(
                    slug=slug,
                    base=base,
                    version=version,
                    tag=BUILDROOT_IMAGE_TAG,
                )
            except (KeyError, ValueError):
                return BUILDROOT_IMAGE
        tag = f"{slug}-{BUILDROOT_IMAGE_TAG}" if BUILDROOT_IMAGE_TAG else slug
        return f"{BUILDROOT_IMAGE_REPO}:{tag}"

    def _legacy_buildroot_image(self) -> str:
        base = self._sanitize(BUILDROOT_DOCKER_IMAGE.replace("/", "_"))
        version = self._sanitize(BUILDROOT_VERSION)
        return f"frameos-buildroot-{base}-{version}-v1"

    def _resolved_buildroot_image(self) -> str:
        image = self._buildroot_image()
        if BUILDROOT_IMAGE:
            return image
        digest = _buildroot_digest_map().get(image)
        if digest:
            return f"{image}@{digest}"
        return image

    async def _buildroot_image_has_compose_tools(self, image: str) -> bool:
        status, _out, _err = await self._run_command(
            " ".join(
                [
                    "docker run --rm",
                    shlex.quote(image),
                    "sh -lc",
                    shlex.quote(
                        "command -v genimage >/dev/null 2>&1"
                        " && command -v mkfs.vfat >/dev/null 2>&1"
                        " && command -v mcopy >/dev/null 2>&1"
                        " && command -v mlabel >/dev/null 2>&1"
                        " && command -v debugfs >/dev/null 2>&1"
                    ),
                ]
            ),
            log_command=False,
            log_output=False,
        )
        return status == 0

    @staticmethod
    def _host_has_compose_tools() -> bool:
        return all(shutil.which(tool) for tool in BUILDROOT_COMPOSE_TOOLS)

    @staticmethod
    def _host_has_boot_patch_tools() -> bool:
        return all(shutil.which(tool) for tool in BUILDROOT_BOOT_PATCH_TOOLS)

    async def _precompiled_sd_image_patch_image(self) -> str | None:
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
        if self.build_environment_provider == "none":
            return None
        if self.executor.uses_local_filesystem and self._host_has_boot_patch_tools():
            return None
        return await self._compose_tools_image()

    async def _ensure_buildroot_image(self) -> str:
        image = self._buildroot_image()
        resolved_image = self._resolved_buildroot_image()
        if self.executor is None:
            raise RuntimeError("Build executor unavailable during Buildroot SD image generation")
        if self.executor.uses_container_images_directly:
            return self.executor.container_image_reference(image, resolved_image)
        if not BUILDROOT_FORCE_LOCAL_BUILD:
            status, _out, _err = await self._run_command(
                f"docker image inspect {shlex.quote(resolved_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0 and await self._buildroot_image_has_compose_tools(resolved_image):
                return resolved_image

            if resolved_image != image:
                status, _out, _err = await self._run_command(
                    f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1",
                    log_command=False,
                    log_output=False,
                )
                if status == 0 and await self._buildroot_image_has_compose_tools(image):
                    return image

            legacy_image = self._legacy_buildroot_image()
            status, _out, _err = await self._run_command(
                f"docker image inspect {shlex.quote(legacy_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0 and await self._buildroot_image_has_compose_tools(legacy_image):
                return legacy_image

            if not BUILDROOT_SKIP_PULL:
                pull_cmd = f"docker pull {shlex.quote(resolved_image)}"
                status, _pull_out, pull_err = await self._run_command(
                    pull_cmd,
                    log_command=f"docker pull {shlex.quote(resolved_image)}",
                    log_output=False,
                )
                if status == 0 and await self._buildroot_image_has_compose_tools(resolved_image):
                    return resolved_image

                if resolved_image != image:
                    status, _pull_out, pull_err = await self._run_command(
                        f"docker pull {shlex.quote(image)}",
                        log_command=f"docker pull {shlex.quote(image)}",
                        log_output=False,
                    )
                    if status == 0 and await self._buildroot_image_has_compose_tools(image):
                        return image

                await self._log(
                    "stderr",
                    f"Falling back to local Buildroot image build after pull failed or missed required image tools for {resolved_image}: {pull_err or 'unknown error'}",
                )

        if not BUILDROOT_DOCKERFILE.exists():
            raise RuntimeError(
                "Buildroot Dockerfile is missing; expected at backend/tools/buildroot.Dockerfile",
            )

        context_dir, dockerfile_arg = await self.executor.prepare_docker_build_context(
            BUILDROOT_DOCKERFILE,
            "buildroot-dockerfile",
        )

        build_cmd = " ".join(
            [
                "docker build --load",
                f"--build-arg BASE_IMAGE={shlex.quote(BUILDROOT_DOCKER_IMAGE)}",
                f"--build-arg BUILDROOT_VERSION={shlex.quote(BUILDROOT_VERSION)}",
                f"--build-arg BUILDROOT_APT_DEPS={shlex.quote(BUILDROOT_DOCKER_APT_DEPS_LINE)}",
                f"-t {shlex.quote(image)}",
                f"-f {shlex.quote(dockerfile_arg)}",
                shlex.quote(context_dir),
            ]
        )
        status, _stdout, err = await self._run_command(
            build_cmd,
            log_command="docker build (buildroot image)",
        )
        if status != 0:
            raise RuntimeError(f"Failed to build Buildroot image: {err or 'see logs'}")
        return image

    @staticmethod
    def _buildroot_output_cache_key(
        build_id: str,
        overlay_dir: Path,
        config_path: Path,
        post_build_path: Path,
        partition_post_build_path: Path,
        post_image_path: Path,
        *,
        build_image: str,
        skip_apt_install: bool,
    ) -> str:
        def normalize_path(value: str) -> str:
            return value.replace(f"release_{build_id}", "release_$BUILD_ID")

        digest = hashlib.sha256()
        digest.update(f"buildroot-version={BUILDROOT_VERSION}\n".encode("utf-8"))
        digest.update(f"buildroot-defconfig={BUILDROOT_DEFCONFIG}\n".encode("utf-8"))
        digest.update(f"buildroot-bootstrap-image={build_image}\n".encode("utf-8"))
        digest.update(f"buildroot-skip-apt-install={skip_apt_install}\n".encode("utf-8"))
        digest.update(f"buildroot-bootstrap-script-version={BUILDROOT_BOOTSTRAP_SCRIPT_VERSION}\n".encode("utf-8"))
        digest.update(f"buildroot-bootstrap-deps={BUILDROOT_DOCKER_APT_DEPS_LINE}\n".encode("utf-8"))
        digest.update(f"buildroot-frameos-partition-size={BUILDROOT_FRAMEOS_PARTITION_SIZE}\n".encode("utf-8"))
        digest.update(f"buildroot-assets-partition-size={BUILDROOT_ASSETS_PARTITION_SIZE}\n".encode("utf-8"))
        digest.update(f"buildroot-host-cxxflags={BUILDROOT_HOST_CXXFLAGS}\n".encode("utf-8"))
        for path in (config_path, post_build_path, partition_post_build_path, post_image_path):
            digest.update(f"path={path.name}\n".encode("utf-8"))
            digest.update(path.read_bytes())
        for path in sorted(overlay_dir.rglob("*"), key=lambda candidate: candidate.relative_to(overlay_dir).as_posix()):
            relpath = normalize_path(path.relative_to(overlay_dir).as_posix())
            if path.is_symlink():
                digest.update(f"symlink:{relpath} -> {normalize_path(os.readlink(path))}\n".encode("utf-8"))
                continue
            if path.is_dir():
                digest.update(f"dir:{relpath}\n".encode("utf-8"))
                continue
            if path.is_file():
                digest.update(f"file:{relpath}\n".encode("utf-8"))
                with path.open("rb") as fh:
                    for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                        digest.update(chunk)
        return digest.hexdigest()


POST_BUILD_SCRIPT = """#!/usr/bin/env bash
set -euo pipefail

target_dir="${TARGET_DIR:?TARGET_DIR is required}"

chmod 0755 "$target_dir/srv/frameos/current/frameos" || true
chmod 0755 "$target_dir/srv/frameos/remote/current/frameos_remote" || true
mkdir -p "$target_dir/etc/systemd/system/multi-user.target.wants" "$target_dir/etc/cron.d"
if [ -f "$target_dir/srv/frameos/current/frameos.service" ]; then
  install -m 0644 "$target_dir/srv/frameos/current/frameos.service" "$target_dir/etc/systemd/system/frameos.service"
  rm -f "$target_dir/etc/systemd/system/multi-user.target.wants/frameos.service"
  ln -s ../frameos.service "$target_dir/etc/systemd/system/multi-user.target.wants/frameos.service"
fi
if [ -f "$target_dir/boot/frameos-hostname" ]; then
  install -m 0644 "$target_dir/boot/frameos-hostname" "$target_dir/etc/hostname"
fi

if [ -d "$target_dir/usr/lib/firmware/brcm" ]; then
  cd "$target_dir/usr/lib/firmware/brcm"
  for base in brcmfmac43436-sdio brcmfmac43436s-sdio brcmfmac43430-sdio; do
    for model in raspberrypi,model-zero-2-w raspberrypi,model-zero-2-2; do
      if [ -e "${base}.bin" ] && [ ! -e "${base}.${model}.bin" ]; then
        ln -s "${base}.bin" "${base}.${model}.bin" || true
      fi
      if [ -e "${base}.txt" ] && [ ! -e "${base}.${model}.txt" ]; then
        ln -s "${base}.txt" "${base}.${model}.txt" || true
      fi
    done
  done
fi

rpi_wifi_firmware_commit="c91cd2804cf7463aab913e7247c176049f16bbd6"
rpi_wifi_firmware_base_url="https://raw.githubusercontent.com/RPi-Distro/firmware-nonfree/${rpi_wifi_firmware_commit}/debian/config/brcm80211/brcm"
rpi_wifi_firmware_dir="$target_dir/usr/lib/firmware/brcm"
mkdir -p "$rpi_wifi_firmware_dir"
rpi_wifi_tmp="$(mktemp -d)"
trap 'rm -rf "$rpi_wifi_tmp"' EXIT

while read -r expected_sha firmware_name; do
  [ -n "$firmware_name" ] || continue
  destination="$rpi_wifi_firmware_dir/$firmware_name"
  if [ -f "$destination" ]; then
    actual_sha="$(sha256sum "$destination" | awk '{print $1}')"
    if [ "$actual_sha" = "$expected_sha" ]; then
      continue
    fi
  fi

  encoded_firmware_name="${firmware_name//,/%2C}"
  curl -fsSL --retry 3 --retry-delay 2 \
    -o "$rpi_wifi_tmp/$firmware_name" \
    "$rpi_wifi_firmware_base_url/$encoded_firmware_name"
  printf '%s  %s\n' "$expected_sha" "$rpi_wifi_tmp/$firmware_name" | sha256sum -c -
  install -m 0644 "$rpi_wifi_tmp/$firmware_name" "$destination"
done <<'EOF'
510a7dd1e056199b309425548ee0bd846993a1837ac7fa1e4d3e641f05a1327a brcmfmac43436-sdio.bin
fce7cbb62ffa6a5a65ca97b13f6fbf28d06c02d986c2072d65bf72164755fc34 brcmfmac43436-sdio.clm_blob
4cda90facd8844cff60d80b34b24ecbae76adb9a62508a109461b8bf42b478d1 brcmfmac43436-sdio.txt
68b9bcc9855d91733cd44c21de4cb507c91b0d32d838c0696def5eb96c99e2de brcmfmac43436s-sdio.bin
37a8b85a5a9742761101b764a07bc4d0c8b09f2e180eaea3b503a834277ad595 brcmfmac43436s-sdio.txt
EOF

while read -r firmware_link firmware_target; do
  [ -n "$firmware_link" ] || continue
  rm -f "$rpi_wifi_firmware_dir/$firmware_link"
  ln -s "$firmware_target" "$rpi_wifi_firmware_dir/$firmware_link"
done <<'EOF'
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436-sdio.bin
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.clm_blob brcmfmac43436-sdio.clm_blob
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436-sdio.txt
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436-sdio.bin
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.clm_blob brcmfmac43436-sdio.clm_blob
brcmfmac43430b0-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436-sdio.txt
brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436-sdio.bin
brcmfmac43436-sdio.raspberrypi,model-zero-2-w.clm_blob brcmfmac43436-sdio.clm_blob
brcmfmac43436-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436-sdio.txt
brcmfmac43436-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436-sdio.bin
brcmfmac43436-sdio.raspberrypi,model-zero-2-2.clm_blob brcmfmac43436-sdio.clm_blob
brcmfmac43436-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436-sdio.txt
brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.bin brcmfmac43436s-sdio.bin
brcmfmac43436s-sdio.raspberrypi,model-zero-2-w.txt brcmfmac43436s-sdio.txt
brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.bin brcmfmac43436s-sdio.bin
brcmfmac43436s-sdio.raspberrypi,model-zero-2-2.txt brcmfmac43436s-sdio.txt
EOF
"""


PARTITION_POST_BUILD_SCRIPT = """#!/usr/bin/env bash
set -euo pipefail

target_dir="${TARGET_DIR:?TARGET_DIR is required}"
base_dir="${BASE_DIR:?BASE_DIR is required}"
frameos_root="${base_dir}/frameos-partition-root"
assets_root="${base_dir}/assets-partition-root"

rm -rf "$frameos_root" "$assets_root"
mkdir -p "$frameos_root" "$assets_root" "$target_dir/srv"

if [ -d "$target_dir/srv/frameos" ]; then
  cp -a "$target_dir/srv/frameos/." "$frameos_root/" 2>/dev/null || true
  rm -rf "$target_dir/srv/frameos"
fi
if [ -d "$target_dir/srv/assets" ]; then
  cp -a "$target_dir/srv/assets/." "$assets_root/" 2>/dev/null || true
  rm -rf "$target_dir/srv/assets"
fi
if ! find "$assets_root" -mindepth 1 -maxdepth 1 | grep -q .; then
  touch "$assets_root/frameos-assets-placeholder"
fi

mkdir -p "$target_dir/srv/frameos" "$target_dir/srv/assets" "$target_dir/etc"
fstab="$target_dir/etc/fstab"
tmp_fstab="${fstab}.frameos"
touch "$fstab"
grep -vE '[[:space:]](/boot|/srv/(frameos|assets))[[:space:]]' "$fstab" > "$tmp_fstab" || true
cat >> "$tmp_fstab" <<'EOF'
LABEL=BOOT /boot vfat defaults,noatime,umask=000 0 0
LABEL=FRAMEOS /srv/frameos ext4 defaults,noatime 0 2
LABEL=ASSETS /srv/assets vfat defaults,noatime,umask=000 0 0
EOF
mv "$tmp_fstab" "$fstab"
"""


POST_IMAGE_SCRIPT = f"""#!/usr/bin/env bash
set -euo pipefail

board_dir="/build/buildroot/board/raspberrypi"
genimage_cfg="${{BINARIES_DIR:?BINARIES_DIR is required}}/frameos-genimage.cfg"
genimage_tmp="${{BUILD_DIR:?BUILD_DIR is required}}/genimage.tmp"
rootpath_tmp="$(mktemp -d)"
trap 'rm -rf "$rootpath_tmp"' EXIT

cmdline="${{BINARIES_DIR:?BINARIES_DIR is required}}/rpi-firmware/cmdline.txt"
if [ -f "$cmdline" ]; then
  tmp_cmdline="${{cmdline}}.frameos"
  tr -d '\\n' < "$cmdline" > "$tmp_cmdline"
  if ! grep -Eq '(^|[[:space:]])console=tty1([[:space:]]|$)' "$tmp_cmdline"; then
    printf ' console=tty1' >> "$tmp_cmdline"
  fi
  if ! grep -Eq '(^|[[:space:]])fbcon=logo-count:' "$tmp_cmdline"; then
    printf ' fbcon=logo-count:1' >> "$tmp_cmdline"
  fi
  printf '\\n' >> "$tmp_cmdline"
  mv "$tmp_cmdline" "$cmdline"
fi

boot_config="${{BINARIES_DIR:?BINARIES_DIR is required}}/rpi-firmware/config.txt"
if [ -f "$boot_config" ]; then
  python3 - "$boot_config" <<'PY'
import sys

path = sys.argv[1]
gpu_keys = {{"gpu_mem", "gpu_mem_256", "gpu_mem_512", "gpu_mem_1024"}}

with open(path, encoding="utf-8") as handle:
    lines = handle.read().splitlines()

line = "{BUILDROOT_DEFAULT_BOOT_CONFIG_LINES[0]}"
lines = [
    existing for existing in lines
    if existing == line or existing.split("=", 1)[0] not in gpu_keys
]
if line not in lines:
    lines.append(line)

with open(path, "w", encoding="utf-8") as handle:
    handle.write("\\n".join(lines).strip() + "\\n")
PY
fi

rootfs_image="${{BINARIES_DIR:?BINARIES_DIR is required}}/rootfs.ext4"
if [ -f "$rootfs_image" ]; then
  e2fsck -fy "$rootfs_image"
  resize2fs -M "$rootfs_image"
fi

files=()
for candidate in "${{BINARIES_DIR}}"/*.dtb "${{BINARIES_DIR}}"/rpi-firmware/*; do
  if [ -e "$candidate" ]; then
    files+=("${{candidate#${{BINARIES_DIR}}/}}")
  fi
done

kernel="$(sed -n 's/^kernel=//p' "${{BINARIES_DIR}}/rpi-firmware/config.txt" || true)"
if [ -n "$kernel" ]; then
  files+=("$kernel")
fi

partition_size_for_root() {{
  python3 - "$1" "$2" <<'PY'
import math
import os
import re
import sys

HEADROOM_BYTES = {BUILDROOT_DATA_PARTITION_HEADROOM_BYTES}
HEADROOM_RATIO = {BUILDROOT_DATA_PARTITION_HEADROOM_RATIO}
MIB = 1024 * 1024

def parse_size(value):
    match = re.fullmatch(r"\\s*([0-9]+)\\s*([KMG]?)\\s*", value, flags=re.IGNORECASE)
    if not match:
        raise SystemExit(f"Unsupported partition size {{value!r}}")
    number = int(match.group(1))
    unit = match.group(2).upper()
    return number * {{"": 1, "K": 1024, "M": MIB, "G": 1024 * MIB}}[unit]

root = sys.argv[1]
minimum = parse_size(sys.argv[2])
payload = 0
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in dirnames + filenames:
        try:
            payload += os.lstat(os.path.join(dirpath, name)).st_size
        except FileNotFoundError:
            pass

required = max(minimum, math.ceil(payload * HEADROOM_RATIO) + HEADROOM_BYTES)
print(f"{{math.ceil(required / MIB)}}M")
PY
}}

frameos_partition_size="$(partition_size_for_root "${{BASE_DIR:?BASE_DIR is required}}/frameos-partition-root" "{BUILDROOT_FRAMEOS_PARTITION_SIZE}")"
assets_partition_size="$(partition_size_for_root "${{BASE_DIR:?BASE_DIR is required}}/assets-partition-root" "{BUILDROOT_ASSETS_PARTITION_SIZE}")"
boot_files="$(printf '\\t\\t\\t"%s",\\n' "${{files[@]}}")"
cat > "$genimage_cfg" <<EOF
image boot.vfat {{
	vfat {{
		label = "BOOT"
		files = {{
$boot_files
		}}
	}}

	size = 32M
}}

image frameos.ext4 {{
	ext4 {{
		use-mke2fs = true
		label = "FRAMEOS"
	}}
	srcpath = "${{BASE_DIR:?BASE_DIR is required}}/frameos-partition-root"
	size = $frameos_partition_size
}}

image assets.vfat {{
	vfat {{
		label = "ASSETS"
	}}
	srcpath = "${{BASE_DIR}}/assets-partition-root"
	size = $assets_partition_size
}}

image sdcard.img {{
	hdimage {{
	}}

	partition boot {{
		partition-type = 0xC
		bootable = "true"
		image = "boot.vfat"
	}}

	partition rootfs {{
		partition-type = 0x83
		image = "rootfs.ext4"
	}}

	partition frameos {{
		partition-type = 0x83
		image = "frameos.ext4"
	}}

	partition assets {{
		partition-type = 0xC
		image = "assets.vfat"
	}}
}}
EOF

rm -rf "$genimage_tmp"
genimage \\
  --rootpath "$rootpath_tmp" \\
  --tmppath "$genimage_tmp" \\
  --inputpath "$BINARIES_DIR" \\
  --outputpath "$BINARIES_DIR" \\
  --config "$genimage_cfg"
"""


EXPAND_SD_CARD_SCRIPT = """#!/bin/sh
set -eu

marker="/var/lib/frameos/sd-card-expanded"
log="/var/log/frameos-expand-sd-card.log"
mount -o remount,rw / 2>/dev/null || true
mkdir -p "$(dirname "$marker")" 2>/dev/null || true
touch "$log" 2>/dev/null || true
exec >> "$log" 2>&1 || true

if [ -e "$marker" ]; then
  exit 0
fi

# The log only lands on disk, so mirror progress messages to the boot console
# (tty1) too: a partition move can take minutes and the frame would otherwise
# look stuck on a blank screen.
notice() {
  echo "$@"
  echo "$@" > /dev/console 2>/dev/null || true
}

sector_size="${FRAMEOS_EXPAND_SECTOR_SIZE:-512}"
align_sectors=$((1024 * 1024 / sector_size))
align_offset=0
small_card_threshold_sectors=$((4 * 1024 * 1024 * 1024 / sector_size))
root_target_sectors=$((1 * 1024 * 1024 * 1024 / sector_size))
small_frameos_sectors=$((1 * 1024 * 1024 * 1024 / sector_size))
large_frameos_sectors=$((2 * 1024 * 1024 * 1024 / sector_size))

partition_device() {
  case "$1" in
    *[0-9]) printf '%sp%s\\n' "$1" "$2" ;;
    *) printf '%s%s\\n' "$1" "$2" ;;
  esac
}

parent_disk_for_partition() {
  part_name="$(basename "$1")"
  sys_path="$(readlink -f "/sys/class/block/$part_name" 2>/dev/null || true)"
  if [ -z "$sys_path" ]; then
    return 1
  fi
  disk_name="$(basename "$(dirname "$sys_path")")"
  printf '/dev/%s\\n' "$disk_name"
}

align_down() {
  value="$1"
  adjusted=$((value - align_offset))
  printf '%s\\n' $((adjusted / align_sectors * align_sectors + align_offset))
}

align_up() {
  value="$1"
  adjusted=$((value - align_offset))
  printf '%s\\n' $(((adjusted + align_sectors - 1) / align_sectors * align_sectors + align_offset))
}

copy_chunk() {
  src="$1"
  dst="$2"
  count="$3"
  if dd if="$disk" of="$disk" bs="$sector_size" skip="$src" seek="$dst" count="$count" conv=notrunc status=none 2>/dev/null; then
    return 0
  fi
  dd if="$disk" of="$disk" bs="$sector_size" skip="$src" seek="$dst" count="$count" conv=notrunc >/dev/null 2>&1
}

move_partition_data() {
  name="$1"
  old_start="$2"
  new_start="$3"
  sectors="$4"
  if [ "$old_start" -eq "$new_start" ]; then
    return 0
  fi
  notice "FrameOS: moving $name partition data ($sectors sectors), please wait..."
  echo "Moving $name data: $old_start -> $new_start ($sectors sectors)"
  chunk_sectors=$((4 * 1024 * 1024 / sector_size))
  if [ "$chunk_sectors" -lt 1 ]; then
    chunk_sectors=1
  fi

  if [ "$new_start" -gt "$old_start" ] && [ "$new_start" -lt $((old_start + sectors)) ]; then
    remaining="$sectors"
    while [ "$remaining" -gt 0 ]; do
      chunk="$chunk_sectors"
      if [ "$chunk" -gt "$remaining" ]; then
        chunk="$remaining"
      fi
      offset=$((remaining - chunk))
      copy_chunk $((old_start + offset)) $((new_start + offset)) "$chunk"
      remaining="$offset"
    done
  else
    copied=0
    while [ "$copied" -lt "$sectors" ]; do
      chunk="$chunk_sectors"
      remaining=$((sectors - copied))
      if [ "$chunk" -gt "$remaining" ]; then
        chunk="$remaining"
      fi
      copy_chunk $((old_start + copied)) $((new_start + copied)) "$chunk"
      copied=$((copied + chunk))
    done
  fi
  sync
}

field_from_line() {
  line="$1"
  field="$2"
  echo "$line" | sed -n "s/.*${field}=[[:space:]]*\\([0-9A-Fa-fx]*\\).*/\\1/p"
}

partition_line() {
  number="$1"
  sfdisk -d "$disk" | awk -v wanted="$number" '
    /^\\/.*:/{ part_index += 1; if (part_index == wanted) { print; exit } }
  '
}

disk="${FRAMEOS_EXPAND_DISK:-}"
if [ -z "$disk" ]; then
  frameos_dev="$(readlink -f /dev/disk/by-label/FRAMEOS 2>/dev/null || true)"
  if [ -z "$frameos_dev" ] && command -v blkid >/dev/null 2>&1; then
    frameos_dev="$(blkid -L FRAMEOS 2>/dev/null || true)"
  fi
  if [ -n "$frameos_dev" ]; then
    disk="$(parent_disk_for_partition "$frameos_dev" || true)"
  fi
fi
if [ -z "$disk" ] || { [ ! -b "$disk" ] && [ "${FRAMEOS_EXPAND_DRY_RUN:-0}" != "1" ]; }; then
  echo "Could not determine SD card block device"
  exit 1
fi

disk_name="$(basename "$disk")"
if [ -n "${FRAMEOS_EXPAND_DISK_SECTORS:-}" ]; then
  disk_sectors="$FRAMEOS_EXPAND_DISK_SECTORS"
else
  if [ ! -b "$disk" ]; then
    echo "FRAMEOS_EXPAND_DISK_SECTORS is required when dry-running against a regular file"
    exit 1
  fi
  disk_sectors="$(cat "/sys/class/block/$disk_name/size")"
fi

p1="$(partition_line 1)"
p2="$(partition_line 2)"
p3="$(partition_line 3)"
p4="$(partition_line 4)"
if [ -z "$p1" ] || [ -z "$p2" ] || [ -z "$p3" ] || [ -z "$p4" ]; then
  echo "Expected four MBR partitions on $disk"
  exit 1
fi

p1_start="$(field_from_line "$p1" start)"
p1_size="$(field_from_line "$p1" size)"
p2_start="$(field_from_line "$p2" start)"
p2_size="$(field_from_line "$p2" size)"
p3_start="$(field_from_line "$p3" start)"
p3_size="$(field_from_line "$p3" size)"
p4_start="$(field_from_line "$p4" start)"
p4_size="$(field_from_line "$p4" size)"

align_offset=$((p2_start % align_sectors))
current_end=$((p4_start + p4_size))
extra_sectors=$((disk_sectors - current_end))

target_root_size="$root_target_sectors"
if [ "$target_root_size" -lt "$p2_size" ]; then
  target_root_size="$p2_size"
fi
frameos_start="$(align_up $((p2_start + target_root_size)))"
target_root_size=$((frameos_start - p2_start))

target_frameos_size="$large_frameos_sectors"
if [ "$disk_sectors" -lt "$small_card_threshold_sectors" ]; then
  target_frameos_size="$small_frameos_sectors"
fi
if [ "$target_frameos_size" -lt "$p3_size" ]; then
  target_frameos_size="$p3_size"
fi

assets_start="$(align_up $((frameos_start + target_frameos_size)))"
target_frameos_size=$((assets_start - frameos_start))
assets_size=$((disk_sectors - assets_start))
if [ "$assets_size" -le 0 ]; then
  echo "Computed assets partition would not fit"
  exit 1
fi
root_dev="$(partition_device "$disk" 2)"
frameos_dev="$(partition_device "$disk" 3)"
assets_dev="$(partition_device "$disk" 4)"

assets_label() {
  if command -v blkid >/dev/null 2>&1; then
    blkid -s LABEL -o value "$assets_dev" 2>/dev/null || true
  elif [ -e /dev/disk/by-label/ASSETS ]; then
    printf 'ASSETS\\n'
  fi
}

layout_changed=0
if [ "$target_root_size" -ne "$p2_size" ] \
  || [ "$frameos_start" -ne "$p3_start" ] \
  || [ "$target_frameos_size" -ne "$p3_size" ] \
  || [ "$assets_start" -ne "$p4_start" ] \
  || [ "$assets_size" -ne "$p4_size" ]; then
  layout_changed=1
fi

if [ "$extra_sectors" -lt "$align_sectors" ] && [ "$layout_changed" -eq 0 ]; then
  echo "No SD card expansion needed"
  resize2fs "$root_dev" || true
  resize2fs "$frameos_dev" || true
  if [ "$(assets_label)" != "ASSETS" ]; then
    echo "Formatting missing ASSETS filesystem on $assets_dev"
    mkfs.vfat -n ASSETS "$assets_dev"
  fi
  date -u > "$marker" 2>/dev/null || true
  exit 0
fi

notice "FrameOS: expanding SD card partitions on first boot. This can take a few minutes - do not power off."
echo "Expanding $disk from $current_end to $disk_sectors sectors"
echo "New root start/size: $p2_start/$target_root_size sectors"
echo "New FRAMEOS start/size: $frameos_start/$target_frameos_size sectors"
echo "New ASSETS start/size: $assets_start/$assets_size sectors"

if [ "${FRAMEOS_EXPAND_DRY_RUN:-0}" = "1" ]; then
  echo "Dry run requested; not moving partitions, rewriting the partition table, or resizing filesystems"
  exit 0
fi

move_partition_data "FRAMEOS" "$p3_start" "$frameos_start" "$p3_size"

layout="$(mktemp)"
cat > "$layout" <<EOF
label: dos
unit: sectors

$(partition_device "$disk" 1) : start= $p1_start, size= $p1_size, type=c, bootable
$(partition_device "$disk" 2) : start= $p2_start, size= $target_root_size, type=83
$(partition_device "$disk" 3) : start= $frameos_start, size= $target_frameos_size, type=83
$(partition_device "$disk" 4) : start= $assets_start, size= $assets_size, type=c
EOF
sfdisk --no-reread --force "$disk" < "$layout"
rm -f "$layout"

if ! partx -u "$disk"; then
  notice "FrameOS: rebooting to finish SD card partition expansion..."
  echo "Could not update in-kernel partition table; rebooting and retrying before local mounts"
  systemctl reboot --no-block || reboot || true
  exit 0
fi

notice "FrameOS: resizing filesystems..."
resize2fs "$root_dev"
resize2fs "$frameos_dev"
mkfs.vfat -n ASSETS "$assets_dev"
date -u > "$marker" 2>/dev/null || true
notice "FrameOS: SD card partition expansion complete, continuing boot."
"""


def render_expand_sd_card_script() -> str:
    return EXPAND_SD_CARD_SCRIPT


def render_expand_sd_card_service() -> str:
    return "\n".join(
        [
            "[Unit]",
            "Description=Expand FrameOS SD card partitions on first boot",
            "DefaultDependencies=no",
            "After=systemd-remount-fs.service",
            "Before=local-fs-pre.target local-fs.target",
            "ConditionPathExists=!/var/lib/frameos/sd-card-expanded",
            "",
            "[Service]",
            "Type=oneshot",
            f"ExecStart={BUILDROOT_EXPAND_SD_CARD_SCRIPT_PATH}",
            "RemainAfterExit=yes",
            "",
            "[Install]",
            "WantedBy=local-fs-pre.target",
            "",
        ]
    )


async def _buildroot_sd_image_queue_job_active(redis: Redis, sd_image: dict[str, Any]) -> bool:
    job_id = sd_image.get("queueJobId")
    if not isinstance(job_id, str) or not job_id:
        return False
    try:
        status = await Job(job_id, redis).status()
        return status in ACTIVE_ARQ_JOB_STATUSES and not _sd_image_inactive(sd_image)
    except Exception:
        return not _sd_image_inactive(sd_image)


def _sd_image_inactive(sd_image: dict[str, Any]) -> bool:
    timestamp = _parse_utc(sd_image.get("lastHeartbeatAt") or sd_image.get("startedAt") or sd_image.get("queuedAt"))
    if timestamp is None:
        return True
    age_seconds = (datetime.now(timezone.utc) - timestamp).total_seconds()
    return age_seconds > _sd_image_inactive_after_seconds(sd_image)


def _sd_image_inactive_after_seconds(sd_image: dict[str, Any]) -> int:
    if sd_image.get("status") == "queued":
        return BUILDROOT_IMAGE_QUEUE_INACTIVE_AFTER_SECONDS
    return BUILDROOT_IMAGE_INACTIVE_AFTER_SECONDS


def _sd_image_state_stale(sd_image: dict[str, Any]) -> bool:
    timestamp = _parse_utc(sd_image.get("startedAt") or sd_image.get("queuedAt"))
    if timestamp is None:
        return True
    age_seconds = (datetime.now(timezone.utc) - timestamp).total_seconds()
    return age_seconds > BUILDROOT_IMAGE_STALE_AFTER_SECONDS


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
    return f"buildroot_sd_image:{frame_id}:{request_id}"


def _sd_image_request_matches(frame: Frame, request_id: str) -> bool:
    sd_image = latest_buildroot_sd_image(frame) or {}
    return sd_image.get("requestId") == request_id


def _preserved_queue_metadata(sd_image: dict[str, Any]) -> dict[str, Any]:
    return {
        key: sd_image[key]
        for key in ("requestId", "queueJobId", "queuedAt")
        if isinstance(sd_image.get(key), str) and sd_image.get(key)
    }


def _with_optional_request_id(sd_image: dict[str, Any], request_id: str | None) -> dict[str, Any]:
    if request_id:
        return {**sd_image, "requestId": request_id}
    return sd_image


def _network_manager_wifi_connection(ssid: str, password: str) -> str:
    return "\n".join(
        [
        "[connection]",
        "id=frameos-wifi",
        "type=wifi",
        "autoconnect=true",
            "",
            "[wifi]",
            "mode=infrastructure",
            f"ssid={_nm_keyfile_value(ssid)}",
            "",
            "[wifi-security]",
            "key-mgmt=wpa-psk",
            f"psk={_nm_keyfile_value(password)}",
            "",
            "[ipv4]",
            "method=auto",
            "",
            "[ipv6]",
            "method=auto",
            "",
        ]
    )


def _nm_keyfile_value(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise ValueError("NetworkManager keyfile values cannot contain line breaks")
    return value.replace("\\", "\\\\")


async def _set_sd_image_status(
    db: Session,
    redis: Redis,
    frame: Frame,
    sd_image: dict[str, Any],
) -> None:
    buildroot = dict(frame.buildroot or {})
    buildroot["platform"] = normalize_buildroot_platform(buildroot.get("platform"))
    buildroot["sdImage"] = sd_image
    frame.buildroot = buildroot
    await update_frame(db, redis, frame)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _gzip_file(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with source_path.open("rb") as source, destination_path.open("wb") as compressed:
        with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as destination:
            shutil.copyfileobj(source, destination)


def _gunzip_file(source_path: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(source_path, "rb") as source, destination_path.open("wb") as destination:
        shutil.copyfileobj(source, destination)


def _mbr_partitions(image_path: Path) -> list[dict[str, int]]:
    with image_path.open("rb") as fh:
        mbr = fh.read(512)
    if len(mbr) != 512 or mbr[510:512] != b"\x55\xaa":
        raise RuntimeError(f"{image_path} does not look like an MBR disk image")
    partitions: list[dict[str, int]] = []
    for index in range(4):
        entry = mbr[446 + index * 16 : 446 + (index + 1) * 16]
        start_lba = int.from_bytes(entry[8:12], "little")
        sectors = int.from_bytes(entry[12:16], "little")
        partitions.append({"start": start_lba * 512, "size": sectors * 512})
    return partitions


def _partition_size_bytes(size: str) -> int:
    match = re.fullmatch(r"\s*([0-9]+)\s*([KMG]?)\s*", size, flags=re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Unsupported partition size {size!r}")
    value = int(match.group(1))
    unit = match.group(2).upper()
    multiplier = {
        "": 1,
        "K": 1024,
        "M": 1024 * 1024,
        "G": 1024 * 1024 * 1024,
    }[unit]
    return value * multiplier


def _align_up_bytes(value: int, alignment: int = 1024 * 1024) -> int:
    return ((value + alignment - 1) // alignment) * alignment


def _directory_payload_size_bytes(root: Path) -> int:
    total = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in [*dirnames, *filenames]:
            try:
                total += (Path(dirpath) / name).lstat().st_size
            except FileNotFoundError:
                continue
    return total


def _partition_size_for_root(root: Path, *, minimum_size: str) -> str:
    minimum_bytes = _partition_size_bytes(minimum_size)
    payload_bytes = _directory_payload_size_bytes(root)
    required_bytes = max(
        minimum_bytes,
        math.ceil(payload_bytes * BUILDROOT_DATA_PARTITION_HEADROOM_RATIO) + BUILDROOT_DATA_PARTITION_HEADROOM_BYTES,
    )
    return f"{_align_up_bytes(required_bytes) // (1024 * 1024)}M"


def _set_mbr_partition_geometry(image_path: Path, partition_number: int, *, start: int, size: int) -> None:
    if partition_number < 1 or partition_number > 4:
        raise RuntimeError(f"Invalid partition number {partition_number}")
    if start % 512 != 0 or size % 512 != 0:
        raise RuntimeError(f"Partition {partition_number} geometry must be sector-aligned")
    with image_path.open("r+b") as image:
        image.seek(446 + (partition_number - 1) * 16 + 8)
        image.write((start // 512).to_bytes(4, "little"))
        image.write((size // 512).to_bytes(4, "little"))


def _shrink_data_partitions(
    image_path: Path,
    partitions: list[dict[str, int]],
    *,
    frameos_image: Path,
    assets_image: Path,
) -> list[dict[str, int]]:
    if len(partitions) < 4:
        raise RuntimeError("Cannot shrink data partitions; SD image has fewer than four partitions")

    frameos_size = frameos_image.stat().st_size
    assets_size = assets_image.stat().st_size
    frameos_partition = partitions[2]
    assets_partition = partitions[3]

    frameos_start = frameos_partition["start"]
    assets_start = _align_up_bytes(frameos_start + frameos_size)
    output_size = assets_start + assets_size

    _set_mbr_partition_geometry(image_path, 3, start=frameos_start, size=frameos_size)
    _set_mbr_partition_geometry(image_path, 4, start=assets_start, size=assets_size)
    with image_path.open("r+b") as image:
        image.truncate(output_size)
    return _mbr_partitions(image_path)


def _replace_partition(image_path: Path, partitions: list[dict[str, int]], partition_number: int, source_path: Path) -> None:
    if partition_number < 1 or partition_number > len(partitions):
        raise RuntimeError(f"Invalid partition number {partition_number}")
    partition = partitions[partition_number - 1]
    source_size = source_path.stat().st_size
    if source_size > partition["size"]:
        raise RuntimeError(
            f"{source_path.name} is larger than partition {partition_number}: {source_size} > {partition['size']}"
        )
    with image_path.open("r+b") as image, source_path.open("rb") as source:
        image.seek(partition["start"])
        shutil.copyfileobj(source, image)


def _hostname_for_frame(frame: Frame) -> str:
    frame_id = getattr(frame, "id", "")
    host = (getattr(frame, "frame_host", "") or f"frame{frame_id}").split(".", 1)[0]
    safe = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in host.lower()).strip("-")
    return safe or f"frame{frame_id}" or "frameos"
