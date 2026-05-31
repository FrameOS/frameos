from __future__ import annotations

import gzip
import copy
import hashlib
import json
import os
import re
import shlex
import shutil
import tempfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional
from types import SimpleNamespace
from urllib.parse import urljoin

from arq import ArqRedis as Redis
from arq.jobs import Job, JobStatus
import httpx
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.codegen.drivers_nim import frame_compilation_mode
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
from app.tasks.deploy_agent import AgentDeployer
from app.tasks.setup_json_reset import (
    BOOT_AUTHORIZED_KEYS_FILE,
    BOOT_HOSTNAME_FILE,
    BOOT_WIFI_CONNECTION_FILE,
    setup_json_reset_enabled,
    setup_json_reset_file_path,
)
from app.tasks.utils import get_fresh_frame
from app.tasks.prebuilt_deps import resolve_prebuilt_target
from app.utils.cross_compile import CrossCompiler, TargetMetadata, cross_cache_key, cross_cache_root
from app.utils.ssh_key_utils import select_ssh_keys_for_frame
from app.utils.local_exec import exec_local_command
from app.utils.token import secure_token
from app.utils.versions import current_frameos_version

REPO_ROOT = Path(__file__).resolve().parents[3]
SUPPORTED_BUILDROOT_PLATFORM = "raspberry-pi-zero-2-w"
BUILDROOT_HOST_CXXFLAGS = "-O2 -pipe -std=gnu++17"
BUILDROOT_HOST_CFLAGS = "-O2 -pipe"
BUILDROOT_JLEVEL = int(os.environ.get("FRAMEOS_BUILDROOT_JLEVEL", "0"))
BUILDROOT_BOOTSTRAP_SCRIPT_VERSION = "4"
BUILDROOT_SD_IMAGE_CUSTOMIZATION_VERSION = 9
BUILDROOT_FRAMEOS_PARTITION_SIZE = os.environ.get("FRAMEOS_BUILDROOT_FRAMEOS_PARTITION_SIZE", "512M")
BUILDROOT_ASSETS_PARTITION_SIZE = os.environ.get("FRAMEOS_BUILDROOT_ASSETS_PARTITION_SIZE", "512M")
BUILDROOT_ARCHIVE_BASE_URL = os.environ.get("FRAMEOS_ARCHIVE_BASE_URL", "https://archive.frameos.net/")
BUILDROOT_BASE_MANIFEST_PATH = os.environ.get("FRAMEOS_BUILDROOT_BASE_MANIFEST_PATH", "buildroot-images/manifest.json")
BUILDROOT_BASE_MANIFEST_FILE = os.environ.get(
    "FRAMEOS_BUILDROOT_BASE_MANIFEST_FILE",
    str(REPO_ROOT / "tools" / "buildroot-images" / "manifest.json"),
)
BUILDROOT_BASE_USE_REMOTE = os.environ.get("FRAMEOS_BUILDROOT_BASE_USE_REMOTE", "").lower() in {"1", "true", "yes"}
BUILDROOT_BASE_TIMEOUT = float(os.environ.get("FRAMEOS_BUILDROOT_BASE_TIMEOUT", "60"))
BUILDROOT_DOCKER_NOFILE_LIMIT = int(os.environ.get("FRAMEOS_BUILDROOT_DOCKER_NOFILE_LIMIT", "65535"))
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
SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")
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
BUILDROOT_IMAGES_DIGESTS_PATH = os.environ.get("FRAMEOS_BUILDROOT_IMAGES_DIGESTS_PATH", str(REPO_ROOT / "buildroot-images.json"))
BUILDROOT_BOOT_LOGO_SOURCE = REPO_ROOT / "backend" / "app" / "tasks" / "assets" / "frameos-boot-logo.png"
BUILDROOT_BOOT_LOGO_WORK_PATH = "/work/frameos-boot-logo.png"
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


def _lgpio_runtime_library_paths() -> list[Path]:
    sysroot = cross_cache_root() / cross_cache_key(FRAMEOS_BUILD_TARGET) / "sysroot"
    libraries: list[Path] = []
    for lib_dir in (sysroot / "usr" / "lib", sysroot / "usr" / "local" / "lib"):
        if not lib_dir.is_dir():
            continue
        for pattern in ("liblgpio.so*", "librgpio.so*"):
            libraries.extend(sorted(path for path in lib_dir.glob(pattern) if path.is_file()))
    prebuilt_target = resolve_prebuilt_target(
        FRAMEOS_BUILD_TARGET.distro,
        FRAMEOS_BUILD_TARGET.version,
        FRAMEOS_BUILD_TARGET.arch,
    )
    if prebuilt_target:
        prebuilt_root = REPO_ROOT / "build" / "prebuilt-deps" / prebuilt_target
        for lib_dir in sorted(prebuilt_root.glob("lgpio-*/lib")):
            if not lib_dir.is_dir():
                continue
            for pattern in ("liblgpio.so*", "librgpio.so*"):
                libraries.extend(sorted(path for path in lib_dir.glob(pattern) if path.is_file()))
    return list(dict.fromkeys(libraries))


def copy_lgpio_runtime_libraries(overlay_dir: Path) -> None:
    runtime_libraries = _lgpio_runtime_library_paths()
    if not runtime_libraries:
        raise RuntimeError("Buildroot image requires lgpio runtime libraries, but none were found in the cross sysroot or prebuilt deps")
    destination = overlay_dir / "usr" / "lib"
    destination.mkdir(parents=True, exist_ok=True)
    for library in runtime_libraries:
        shutil.copy2(library, destination / library.name)


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
        elif not any(existing == line for existing in lines):
            commented_line = f"#{line}"
            before = len(lines)
            lines = [existing for existing in lines if existing != commented_line]
            if len(lines) != before:
                changed = True
            lines.append(line)
            changed = True
    return ("\n".join(lines).strip() + "\n", changed)


def _merge_boot_config_lines(content: str, requested_lines: list[str]) -> str:
    merged, changed = _apply_boot_config_lines(content, requested_lines)
    if not changed:
        return content
    return merged


def _frame_boot_config_lines(frame: Frame) -> list[str]:
    lines: list[str] = []
    seen: set[str] = set()
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
    if sd_image.get("status") == "ready" and not _sd_image_base_matches_current(sd_image, current_base_entry):
        return {
            **sd_image,
            "status": "stale",
            "error": "The generated image was built with an older Buildroot base image",
        }
    if sd_image.get("status") == "ready" and isinstance(path, str) and not Path(path).is_file():
        return {**sd_image, "status": "missing", "error": "The generated image file is missing"}
    return sd_image


async def start_buildroot_sd_image(
    db: Session,
    redis: Redis,
    frame: Frame,
    *,
    force: bool = False,
) -> tuple[bool, dict[str, Any]]:
    current_base_entry = await resolve_buildroot_base_entry(SUPPORTED_BUILDROOT_PLATFORM)
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

    async def run(self) -> dict[str, Any]:
        validate_buildroot_wifi_credentials(self.frame)
        bootstrap_frame = self._buildroot_bootstrap_frame()
        setup_payload = get_frame_json(self.db, self.frame)

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
                    "startedAt": _utc_now(),
                }, self.request_id),
            )
            await self._log("stdout", f"Starting Buildroot SD image build {build_id}")

            frameos_build = await self._build_frameos_binary(deployer, str(temp_dir), self.frame)
            agent_binary = await self._build_agent_binary(deployer, str(temp_dir), self.frame)
            overlay_dir = temp_dir / "overlay"
            self._stage_overlay(
                overlay_dir=overlay_dir,
                build_id=build_id,
                bootstrap_frame=bootstrap_frame,
                setup_payload=setup_payload,
                frameos_build=frameos_build,
                agent_binary=agent_binary,
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
            base_entry = await resolve_buildroot_base_entry(SUPPORTED_BUILDROOT_PLATFORM)
            base_image_path = await ensure_buildroot_base_image(base_entry, buildroot_base_cache_dir())
            compose_image = await self._ensure_buildroot_image()
            await self._compose_sd_image_from_base(
                temp_dir=temp_dir,
                base_image_path=base_image_path,
                output_path=raw_output_path,
                image=compose_image,
            )

            if not raw_output_path.is_file():
                raise RuntimeError(f"SD image composer completed without producing {raw_output_path.name}")

            raw_size = raw_output_path.stat().st_size
            raw_sha256 = _sha256(raw_output_path)
            _gzip_file(raw_output_path, output_path)
            raw_output_path.unlink(missing_ok=True)

            metadata = {
                **_preserved_queue_metadata(latest_buildroot_sd_image(self.frame) or {}),
                "status": "ready",
                "buildId": build_id,
                "platform": SUPPORTED_BUILDROOT_PLATFORM,
                "frameosVersion": current_frameos_version(),
                "buildrootVersion": BUILDROOT_VERSION,
                "baseImage": {
                    "frameosVersion": base_entry.get("frameos_version"),
                    "objectKey": base_entry.get("object_key"),
                    "sha256": base_entry.get("sha256"),
                    "updatedAt": base_entry.get("updated_at"),
                },
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
                "sha256": _sha256(output_path),
                "downloadUrl": f"/api/frames/{self.frame.id}/buildroot/sd_image/download",
                "createdAt": _utc_now(),
                "completedAt": _utc_now(),
            }
            await _set_sd_image_status(self.db, self.redis, self.frame, metadata)
            await self._log("stdout", f"Buildroot SD image ready, starting download, please wait for {filename}")
            return metadata

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
            target_override=FRAMEOS_BUILD_TARGET,
            compilation_mode=frame_compilation_mode(frame),
        )
        return await builder.build(plan, precompiled_install_all_drivers=True)

    async def _build_agent_binary(self, deployer: FrameDeployer, temp_dir: str, frame: Frame) -> str:
        await self._log("stdout", "Building FrameOS agent for Raspberry Pi Zero 2 W")
        agent_deployer = AgentDeployer(self.db, self.redis, frame, "", temp_dir, force_source=True)
        agent_deployer.build_id = deployer.build_id
        build_dir, source_dir = agent_deployer._create_agent_build_folders()
        await agent_deployer._create_local_build_archive(build_dir, source_dir, FRAMEOS_BUILD_TARGET.arch)
        return await CrossCompiler(
            db=self.db,
            redis=self.redis,
            frame=frame,
            deployer=agent_deployer,
            target=FRAMEOS_BUILD_TARGET,
            temp_dir=temp_dir,
            build_dir=build_dir,
            logger=agent_deployer.log,
            output_name="frameos_agent",
            compile_script_name="compile_frameos_agent.sh",
            needs_quickjs=False,
            needs_lgpio=False,
        ).build(source_dir)

    def _stage_overlay(
        self,
        *,
        overlay_dir: Path,
        build_id: str,
        bootstrap_frame: Frame | Any,
        setup_payload: dict[str, Any],
        frameos_build: FrameBinaryBuildResult,
        agent_binary: str,
    ) -> None:
        release_dir = overlay_dir / "srv" / "frameos" / "releases" / f"release_{build_id}"
        agent_release_dir = overlay_dir / "srv" / "frameos" / "agent" / "releases" / f"release_{build_id}"
        state_dir = overlay_dir / "srv" / "frameos" / "state"
        boot_overlay_dir = overlay_dir / "boot"
        assets_dir = overlay_dir / "srv" / "assets"

        for directory in (
            release_dir,
            agent_release_dir,
            state_dir,
            assets_dir,
            boot_overlay_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        if not frameos_build.binary_path:
            raise RuntimeError("FrameOS cross compilation did not produce a binary")
        shutil.copy2(frameos_build.binary_path, release_dir / "frameos")
        os.chmod(release_dir / "frameos", 0o755)
        self._copy_libraries(frameos_build.driver_library_paths, release_dir / "drivers")
        self._copy_libraries(frameos_build.scene_library_paths, release_dir / "scenes")
        self._copy_runtime_libraries(overlay_dir)

        (release_dir / "frame.json").write_text(
            json.dumps(get_frame_json(self.db, bootstrap_frame), indent=4) + "\n",
            encoding="utf-8",
        )
        (release_dir / "scenes.json.gz").write_bytes(
            gzip.compress(
                json.dumps(get_interpreted_scenes_json(bootstrap_frame), indent=4).encode("utf-8") + b"\n",
                mtime=0,
            )
        )
        (release_dir / "all_scenes.json.gz").write_bytes(
            gzip.compress(
                json.dumps(list(getattr(bootstrap_frame, "scenes", []) or []), indent=4).encode("utf-8") + b"\n",
                mtime=0,
            )
        )
        self._write_service(
            REPO_ROOT / "frameos" / "frameos.service",
            release_dir / "frameos.service",
            user="root",
            console_output=True,
            environment={
                "FRAMEOS_HOME": "/srv/frameos/current",
                "LD_LIBRARY_PATH": "/srv/frameos/current/drivers:/srv/frameos/current/scenes:/usr/lib:/usr/local/lib",
            },
        )

        shutil.copy2(agent_binary, agent_release_dir / "frameos_agent")
        os.chmod(agent_release_dir / "frameos_agent", 0o755)
        (agent_release_dir / "frame.json").write_text(
            json.dumps(get_frame_json(self.db, bootstrap_frame), indent=4) + "\n",
            encoding="utf-8",
        )
        self._write_service(
            REPO_ROOT / "frameos" / "agent" / "frameos_agent.service",
            agent_release_dir / "frameos_agent.service",
            user="root",
            console_output=True,
            environment={
                "FRAMEOS_HOME": "/srv/frameos/current",
                "LD_LIBRARY_PATH": "/usr/lib:/usr/local/lib",
            },
        )

        self._relative_symlink(f"releases/release_{build_id}", overlay_dir / "srv" / "frameos" / "current")
        self._relative_symlink(
            f"releases/release_{build_id}",
            overlay_dir / "srv" / "frameos" / "agent" / "current",
        )
        self._relative_symlink("/srv/frameos/state", release_dir / "state")

        setup_reset_enabled = setup_json_reset_enabled(self.frame)
        if setup_reset_enabled:
            setup_file_path = setup_json_reset_file_path(self.frame, default_if_missing=True)
            self._write_setup_payload(_boot_setup_payload_path(boot_overlay_dir, setup_file_path), setup_payload)

        (boot_overlay_dir / Path(BOOT_HOSTNAME_FILE).name).write_text(_hostname_for_frame(self.frame) + "\n", encoding="utf-8")
        self._write_boot_wifi_connection(boot_overlay_dir / Path(BOOT_WIFI_CONNECTION_FILE).name)
        self._write_boot_config(overlay_dir, _frame_boot_config_lines(bootstrap_frame))
        self._write_boot_authorized_keys(boot_overlay_dir / Path(BOOT_AUTHORIZED_KEYS_FILE).name)

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
        destination.write_text("\n".join(rendered_lines) + "\n", encoding="utf-8")

    def _copy_runtime_libraries(self, overlay_dir: Path) -> None:
        copy_lgpio_runtime_libraries(overlay_dir)

    def _write_boot_authorized_keys(self, authorized_keys: Path) -> None:
        settings = get_settings_dict(self.db)
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
                    "BR2_PACKAGE_SUDO=y",
                    "BR2_PACKAGE_CA_CERTIFICATES=y",
                    "BR2_PACKAGE_TZDATA=y",
                    "BR2_PACKAGE_BASH=y",
                    "BR2_PACKAGE_COREUTILS=y",
                    "BR2_PACKAGE_FINDUTILS=y",
                    "BR2_PACKAGE_GZIP=y",
                    "BR2_PACKAGE_TAR=y",
                    "BR2_PACKAGE_NANO=y",
                    "BR2_PACKAGE_IPROUTE2=y",
                    "BR2_PACKAGE_KMOD=y",
                    "BR2_PACKAGE_OPENSSL=y",
                    "BR2_PACKAGE_ZLIB=y",
                    "BR2_PACKAGE_IMAGEMAGICK=y",
                    "BR2_PACKAGE_HOSTAPD=y",
                    "BR2_PACKAGE_DNSMASQ=y",
                    "BR2_PACKAGE_NETWORK_MANAGER=y",
                    "BR2_PACKAGE_NETWORK_MANAGER_CLI=y",
                    "BR2_PACKAGE_NETWORK_MANAGER_WIFI=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT_DBUS=y",
                    "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y",
                    "BR2_PACKAGE_IW=y",
                    "BR2_PACKAGE_WIRELESS_TOOLS=y",
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

        boot_files = [
            overlay_dir / "boot" / "config.txt",
            overlay_dir / "boot" / "firmware" / "config.txt",
        ]
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
        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"--ulimit nofile={BUILDROOT_DOCKER_NOFILE_LIMIT}:{BUILDROOT_DOCKER_NOFILE_LIMIT}",
                f"-v {shlex.quote(str(temp_dir))}:/work",
                f"-v {shlex.quote(str(source_dir))}:/build/buildroot",
                f"-v {shlex.quote(str(output_dir))}:/build/output",
                f"-v {shlex.quote(str(cache_dir))}:/cache",
                f"-v {shlex.quote(str(artifact_dir))}:/artifacts",
                *(["-e BUILDROOT_SKIP_APT_INSTALL=1"] if skip_apt_install else []),
                "-e FORCE_UNSAFE_CONFIGURE=1",
                shlex.quote(image),
                "bash /work/buildroot-build.sh",
            ]
        )
        status, _, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            docker_cmd,
            log_command="docker run (buildroot image)",
        )
        if status != 0:
            raise RuntimeError(f"Buildroot image build failed: {err or 'see logs'}")

    async def _compose_sd_image_from_base(
        self,
        *,
        temp_dir: Path,
        base_image_path: Path,
        output_path: Path,
        image: str,
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

        genimage_cfg = compose_dir / "frameos-genimage.cfg"
        genimage_cfg.write_text(
            f"""image frameos.ext4 {{
	ext4 {{
		use-mke2fs = true
		label = "FRAMEOS"
	}}
	srcpath = "/tmp/frameos-compose-roots/frameos"
	size = {BUILDROOT_FRAMEOS_PARTITION_SIZE}
}}

image assets.vfat {{
	vfat {{
		label = "ASSETS"
	}}
	srcpath = "/tmp/frameos-compose-roots/assets"
	size = {BUILDROOT_ASSETS_PARTITION_SIZE}
}}
""",
            encoding="utf-8",
        )

        script_path = compose_dir / "compose-partitions.sh"
        script_path.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v genimage >/dev/null 2>&1 || ! command -v mkfs.vfat >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends genimage dosfstools e2fsprogs mtools
fi
rm -rf /work/tmp
rm -rf /tmp/frameos-compose-roots
mkdir -p /tmp/frameos-compose-roots
tar -C /work/roots -cf - frameos assets | tar -C /tmp/frameos-compose-roots -xf -
genimage --rootpath /work/empty-root --tmppath /work/tmp --inputpath /work/images --outputpath /work/images --config /work/frameos-genimage.cfg
""",
            encoding="utf-8",
        )
        os.chmod(script_path, 0o755)
        (compose_dir / "empty-root").mkdir(exist_ok=True)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"-v {shlex.quote(str(compose_dir))}:/work",
                shlex.quote(image),
                "bash /work/compose-partitions.sh",
            ]
        )
        status, _, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            docker_cmd,
            log_command="docker run (buildroot image composer)",
        )
        if status != 0:
            raise RuntimeError(f"Buildroot image composition failed: {err or 'see logs'}")

        shutil.copy2(base_image_path, output_path)
        partitions = _mbr_partitions(output_path)
        _replace_partition(output_path, partitions, 3, images_dir / "frameos.ext4")
        _replace_partition(output_path, partitions, 4, images_dir / "assets.vfat")
        await self._patch_boot_partition(output_path, partitions, boot_root, image=image)

    async def _patch_boot_partition(
        self,
        output_path: Path,
        partitions: list[dict[str, int]],
        boot_root: Path,
        *,
        image: str,
    ) -> None:
        if not partitions:
            raise RuntimeError("Cannot patch BOOT partition; SD image has no partitions")

        compose_dir = boot_root.parent.parent
        script_path = compose_dir / "patch-boot.sh"
        script_path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v mlabel >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends mtools
fi
disk=/image/{shlex.quote(output_path.name)}
offset={partitions[0]["start"]}
target="${{disk}}@@${{offset}}"
mlabel -i "$target" ::BOOT
if find /boot-root -mindepth 1 -print -quit | grep -q .; then
  cd /boot-root
  find . -mindepth 1 -maxdepth 1 -exec mcopy -i "$target" -o -s {{}} :: \\;
fi
""",
            encoding="utf-8",
        )
        os.chmod(script_path, 0o755)

        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"-v {shlex.quote(str(output_path.parent))}:/image",
                f"-v {shlex.quote(str(boot_root))}:/boot-root",
                f"-v {shlex.quote(str(script_path))}:/patch-boot.sh",
                shlex.quote(image),
                "bash /patch-boot.sh",
            ]
        )
        status, _, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
            docker_cmd,
            log_command="docker run (buildroot boot partition patch)",
        )
        if status != 0:
            raise RuntimeError(f"Buildroot BOOT partition patch failed: {err or 'see logs'}")

    async def _log(self, type: str, line: str) -> None:
        await log(self.db, self.redis, int(self.frame.id), type, line)

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
        status, _out, _err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
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
                    ),
                ]
            ),
            log_command=False,
            log_output=False,
        )
        return status == 0

    async def _ensure_buildroot_image(self) -> str:
        image = self._buildroot_image()
        resolved_image = self._resolved_buildroot_image()
        if not BUILDROOT_FORCE_LOCAL_BUILD:
            status, _out, _err = await exec_local_command(
                self.db,
                self.redis,
                self.frame,
                f"docker image inspect {shlex.quote(resolved_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0 and await self._buildroot_image_has_compose_tools(resolved_image):
                return resolved_image

            if resolved_image != image:
                status, _out, _err = await exec_local_command(
                    self.db,
                    self.redis,
                    self.frame,
                    f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1",
                    log_command=False,
                    log_output=False,
                )
                if status == 0 and await self._buildroot_image_has_compose_tools(image):
                    return image

            legacy_image = self._legacy_buildroot_image()
            status, _out, _err = await exec_local_command(
                self.db,
                self.redis,
                self.frame,
                f"docker image inspect {shlex.quote(legacy_image)} >/dev/null 2>&1",
                log_command=False,
                log_output=False,
            )
            if status == 0 and await self._buildroot_image_has_compose_tools(legacy_image):
                return legacy_image

            if not BUILDROOT_SKIP_PULL:
                pull_cmd = f"docker pull {shlex.quote(resolved_image)}"
                status, _pull_out, pull_err = await exec_local_command(
                    self.db,
                    self.redis,
                    self.frame,
                    pull_cmd,
                    log_command=f"docker pull {shlex.quote(resolved_image)}",
                    log_output=False,
                )
                if status == 0 and await self._buildroot_image_has_compose_tools(resolved_image):
                    return resolved_image

                if resolved_image != image:
                    status, _pull_out, pull_err = await exec_local_command(
                        self.db,
                        self.redis,
                        self.frame,
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

        build_cmd = " ".join(
            [
                "docker build --load",
                f"--build-arg BASE_IMAGE={shlex.quote(BUILDROOT_DOCKER_IMAGE)}",
                f"--build-arg BUILDROOT_VERSION={shlex.quote(BUILDROOT_VERSION)}",
                f"--build-arg BUILDROOT_APT_DEPS={shlex.quote(BUILDROOT_DOCKER_APT_DEPS_LINE)}",
                f"-t {shlex.quote(image)}",
                f"-f {shlex.quote(str(BUILDROOT_DOCKERFILE))}",
                shlex.quote(str(BUILDROOT_DOCKERFILE.parent)),
            ]
        )
        status, _stdout, err = await exec_local_command(
            self.db,
            self.redis,
            self.frame,
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
chmod 0755 "$target_dir/srv/frameos/agent/current/frameos_agent" || true
mkdir -p "$target_dir/etc/systemd/system/multi-user.target.wants" "$target_dir/etc/cron.d"

if [ -d "$target_dir/lib/firmware/brcm" ]; then
  cd "$target_dir/lib/firmware/brcm"
  for base in brcmfmac43436-sdio brcmfmac43436s-sdio brcmfmac43430-sdio; do
    if [ -e "${base}.bin" ] && [ ! -e "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" ]; then
      ln -s "${base}.bin" "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.bin" || true
    fi
    if [ -e "${base}.txt" ] && [ ! -e "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.txt" ]; then
      ln -s "${base}.txt" "brcmfmac43436-sdio.raspberrypi,model-zero-2-w.txt" || true
    fi
  done
fi
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
grep -vE '[[:space:]]/srv/(frameos|assets)[[:space:]]' "$fstab" > "$tmp_fstab" || true
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
  if ! grep -Eq '(^|[[:space:]])fbcon=logo-count:' "$tmp_cmdline"; then
    printf ' fbcon=logo-count:1' >> "$tmp_cmdline"
  fi
  printf '\\n' >> "$tmp_cmdline"
  mv "$tmp_cmdline" "$cmdline"
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
	size = {BUILDROOT_FRAMEOS_PARTITION_SIZE}
}}

image assets.vfat {{
	vfat {{
		label = "ASSETS"
	}}
	srcpath = "${{BASE_DIR}}/assets-partition-root"
	size = {BUILDROOT_ASSETS_PARTITION_SIZE}
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


async def _buildroot_sd_image_queue_job_active(redis: Redis, sd_image: dict[str, Any]) -> bool:
    job_id = sd_image.get("queueJobId")
    if not isinstance(job_id, str) or not job_id:
        return False
    try:
        status = await Job(job_id, redis).status()
        return status in ACTIVE_ARQ_JOB_STATUSES
    except Exception:
        return not _sd_image_state_stale(sd_image)


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
    host = (frame.frame_host or f"frame{frame.id}").split(".", 1)[0]
    safe = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in host.lower()).strip("-")
    return safe or f"frame{frame.id}"
