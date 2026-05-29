from __future__ import annotations

import gzip
import copy
import hashlib
import json
import os
import shlex
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from types import SimpleNamespace

from arq import ArqRedis as Redis
from arq.jobs import Job, JobStatus
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.codegen.drivers_nim import frame_compilation_mode
from app.models.frame import (
    Frame,
    get_frame_json,
    get_interpreted_scenes_json,
    normalize_buildroot_setup_json_reset_file_path,
    update_frame,
)
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryBuildResult
from app.tasks.deploy_agent import AgentDeployer
from app.tasks.setup_json_reset import (
    SETUP_JSON_RESET_SCRIPT_NAME,
    SETUP_JSON_RESET_SCRIPT_PATH,
    SETUP_JSON_RESET_SERVICE_NAME,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
    setup_json_reset_enabled,
    setup_json_reset_file_path,
)
from app.tasks.utils import get_fresh_frame
from app.utils.cross_compile import CrossCompiler, TargetMetadata, cross_cache_key, cross_cache_root
from app.utils.ssh_key_utils import select_ssh_keys_for_frame
from app.utils.local_exec import exec_local_command
from app.utils.token import secure_token

SUPPORTED_BUILDROOT_PLATFORM = "raspberry-pi-zero-2-w"
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

REPO_ROOT = Path(__file__).resolve().parents[3]
BUILDROOT_VERSION = os.environ.get("FRAMEOS_BUILDROOT_VERSION", "2025.02.13")
BUILDROOT_DEFCONFIG = "raspberrypizero2w_64_defconfig"
BUILDROOT_DOCKER_IMAGE = os.environ.get("FRAMEOS_BUILDROOT_DOCKER_IMAGE", "debian:bookworm")
BUILDROOT_IMAGE_STALE_AFTER_SECONDS = int(
    os.environ.get("FRAMEOS_BUILDROOT_IMAGE_STALE_AFTER_SECONDS", str(6 * 60 * 60))
)
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


def buildroot_ccache_dir() -> Path:
    return Path(os.environ.get("FRAMEOS_BUILDROOT_CCACHE_DIR") or (buildroot_cache_dir() / "ccache"))


def _lgpio_runtime_library_paths() -> list[Path]:
    sysroot = cross_cache_root() / cross_cache_key(FRAMEOS_BUILD_TARGET) / "sysroot"
    libraries: list[Path] = []
    for lib_dir in (sysroot / "usr" / "lib", sysroot / "usr" / "local" / "lib"):
        if not lib_dir.is_dir():
            continue
        for pattern in ("liblgpio.so*", "librgpio.so*"):
            libraries.extend(sorted(path for path in lib_dir.glob(pattern) if path.is_file()))
    return list(dict.fromkeys(libraries))


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
            "StandardInput=tty",
            "TTYPath=/dev/tty1",
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


def _buildroot_setup_payload_path(overlay_dir: Path, setup_file_path: str) -> Path:
    relative_path = setup_file_path.lstrip("/")
    if not relative_path:
        raise ValueError("Setup JSON reset file path cannot be empty")
    return overlay_dir / relative_path


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
    buildroot["setupJsonResetFilePath"] = normalize_buildroot_setup_json_reset_file_path(
        buildroot.get("setupJsonResetFilePath"),
        default_if_missing=True,
    )
    frame.buildroot = buildroot


def validate_buildroot_network(network: dict[str, Any] | None) -> tuple[str, str]:
    network = network if isinstance(network, dict) else {}
    ssid = str(network.get("wifiSSID") or "").strip()
    password = str(network.get("wifiPassword") or "")
    if not ssid:
        raise ValueError("WiFi network is required for Buildroot SD card images")
    if not password:
        raise ValueError("WiFi password is required for Buildroot SD card images")
    if "\n" in ssid or "\r" in ssid:
        raise ValueError("WiFi network cannot contain line breaks")
    if "\n" in password or "\r" in password:
        raise ValueError("WiFi password cannot contain line breaks")
    return ssid, password


def validate_buildroot_wifi_credentials(frame: Frame) -> tuple[str, str]:
    network = frame.network if isinstance(frame.network, dict) else {}
    return validate_buildroot_network(network)


def latest_buildroot_sd_image(frame: Frame) -> dict[str, Any] | None:
    buildroot = frame.buildroot if isinstance(frame.buildroot, dict) else {}
    sd_image = buildroot.get("sdImage")
    if not isinstance(sd_image, dict):
        return None
    path = sd_image.get("path")
    if sd_image.get("status") == "ready" and isinstance(path, str) and not Path(path).is_file():
        return {**sd_image, "status": "missing", "error": "The generated image file is missing"}
    return sd_image


async def start_buildroot_sd_image(db: Session, redis: Redis, frame: Frame) -> tuple[bool, dict[str, Any]]:
    sd_image = latest_buildroot_sd_image(frame)
    if sd_image and sd_image.get("status") == "ready":
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
        ccache_dir = buildroot_ccache_dir()
        artifact_dir.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
        source_dir.mkdir(parents=True, exist_ok=True)
        output_cache_root.mkdir(parents=True, exist_ok=True)
        ccache_dir.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix=f"frameos-buildroot-{self.frame.id}-") as tmp:
            temp_dir = Path(tmp)
            deployer = FrameDeployer(self.db, self.redis, self.frame, "", str(temp_dir))
            build_id = deployer.build_id
            filename = f"frameos-{self.frame.id}-{SUPPORTED_BUILDROOT_PLATFORM}-{build_id}.img"
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
                    "filename": filename,
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
            self._write_buildroot_config(config_path)
            self._write_post_build_script(post_build_path)
            self._write_build_script(script_path, output_path.name)

            output_cache_key = self._buildroot_output_cache_key(build_id, overlay_dir, config_path, post_build_path)
            output_dir = output_cache_root / output_cache_key
            output_dir.mkdir(parents=True, exist_ok=True)

            await self._run_buildroot(temp_dir, artifact_dir, cache_dir, source_dir, output_dir)

            if not output_path.is_file():
                raise RuntimeError(f"Buildroot completed without producing {output_path.name}")

            metadata = {
                **_preserved_queue_metadata(latest_buildroot_sd_image(self.frame) or {}),
                "status": "ready",
                "buildId": build_id,
                "platform": SUPPORTED_BUILDROOT_PLATFORM,
                "buildrootVersion": BUILDROOT_VERSION,
                "filename": filename,
                "path": str(output_path),
                "size": output_path.stat().st_size,
                "sha256": _sha256(output_path),
                "downloadUrl": f"/api/frames/{self.frame.id}/buildroot/sd_image/download",
                "createdAt": _utc_now(),
                "completedAt": _utc_now(),
            }
            await _set_sd_image_status(self.db, self.redis, self.frame, metadata)
            await self._log("stdout", f"Buildroot SD image ready: {filename}")
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
        assets_dir = overlay_dir / "srv" / "assets"
        systemd_dir = overlay_dir / "etc" / "systemd" / "system"
        wants_dir = systemd_dir / "multi-user.target.wants"

        for directory in (release_dir, agent_release_dir, state_dir, assets_dir, wants_dir):
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

        shutil.copy2(release_dir / "frameos.service", systemd_dir / "frameos.service")
        shutil.copy2(agent_release_dir / "frameos_agent.service", systemd_dir / "frameos_agent.service")
        setup_reset_enabled = setup_json_reset_enabled(self.frame)
        if setup_reset_enabled:
            setup_file_path = setup_json_reset_file_path(self.frame, default_if_missing=True)
            script_contents = render_setup_json_reset_script(setup_file_path)
            service_contents = render_setup_json_reset_service(
                setup_file_path,
                script_path=SETUP_JSON_RESET_SCRIPT_PATH,
            )
            script_path = overlay_dir / "usr" / "local" / "bin" / SETUP_JSON_RESET_SCRIPT_NAME
            script_path.parent.mkdir(parents=True, exist_ok=True)
            script_path.write_text(script_contents, encoding="utf-8")
            os.chmod(script_path, 0o755)
            (systemd_dir / SETUP_JSON_RESET_SERVICE_NAME).write_text(service_contents, encoding="utf-8")
            self._write_setup_payload(_buildroot_setup_payload_path(overlay_dir, setup_file_path), setup_payload)

        services = ["frameos.service", "frameos_agent.service"]
        if setup_reset_enabled:
            services.append(SETUP_JSON_RESET_SERVICE_NAME)
        for service in services:
            self._relative_symlink(f"../{service}", wants_dir / service)
        self._relative_symlink("/usr/lib/systemd/system/NetworkManager.service", wants_dir / "NetworkManager.service")

        (overlay_dir / "etc").mkdir(parents=True, exist_ok=True)
        (overlay_dir / "etc" / "hostname").write_text(_hostname_for_frame(self.frame) + "\n", encoding="utf-8")
        (overlay_dir / "etc" / "profile.d").mkdir(parents=True, exist_ok=True)
        (overlay_dir / "etc" / "profile.d" / "frameos.sh").write_text(
            "export FRAMEOS_HOME=/srv/frameos/current\n",
            encoding="utf-8",
        )
        network_manager = overlay_dir / "etc" / "NetworkManager" / "conf.d"
        network_manager.mkdir(parents=True, exist_ok=True)
        (network_manager / "frameos.conf").write_text(
            "[main]\nplugins=keyfile\n\n[device]\nwifi.scan-rand-mac-address=no\n",
            encoding="utf-8",
        )
        self._write_wifi_connection(overlay_dir / "etc" / "NetworkManager" / "system-connections")
        self._write_boot_config(overlay_dir, _frame_boot_config_lines(bootstrap_frame))
        self._write_authorized_keys(overlay_dir, wants_dir)

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
        if not self._frame_requires_lgpio():
            return
        runtime_libraries = _lgpio_runtime_library_paths()
        if not runtime_libraries:
            return
        destination = overlay_dir / "usr" / "lib"
        destination.mkdir(parents=True, exist_ok=True)
        for library in runtime_libraries:
            shutil.copy2(library, destination / library.name)

    def _frame_requires_lgpio(self) -> bool:
        return any("-llgpio" in driver.link_flags for driver in drivers_for_frame(self.frame).values())

    def _write_authorized_keys(self, overlay_dir: Path, wants_dir: Path) -> None:
        settings = get_settings_dict(self.db)
        selected_keys = select_ssh_keys_for_frame(self.frame, settings)
        public_keys = [
            key["public"].strip()
            for key in selected_keys
            if isinstance(key.get("public"), str) and key.get("public", "").strip()
        ]
        if not public_keys:
            return

        ssh_dir = overlay_dir / "root" / ".ssh"
        ssh_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(ssh_dir, 0o700)
        authorized_keys = ssh_dir / "authorized_keys"
        authorized_keys.write_text("\n".join(dict.fromkeys(public_keys)) + "\n", encoding="utf-8")
        os.chmod(authorized_keys, 0o600)

        defaults_dir = overlay_dir / "etc" / "default"
        defaults_dir.mkdir(parents=True, exist_ok=True)
        (defaults_dir / "dropbear").write_text('DROPBEAR_ARGS="-s -g"\n', encoding="utf-8")
        self._relative_symlink("/usr/lib/systemd/system/dropbear.service", wants_dir / "dropbear.service")

    def _write_wifi_connection(self, connections_dir: Path) -> None:
        ssid, password = validate_buildroot_wifi_credentials(self.frame)
        connections_dir.mkdir(parents=True, exist_ok=True)
        path = connections_dir / "frameos-wifi.nmconnection"
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
                    'BR2_DL_DIR="/cache/dl"',
                    "BR2_PACKAGE_SYSTEMD=y",
                    "BR2_PACKAGE_SYSTEMD_TIMESYNCD=y",
                    "BR2_PACKAGE_DBUS=y",
                    "BR2_PACKAGE_DROPBEAR=y",
                    "BR2_PACKAGE_SUDO=y",
                    "BR2_PACKAGE_CA_CERTIFICATES=y",
                    "BR2_PACKAGE_COREUTILS=y",
                    "BR2_PACKAGE_FINDUTILS=y",
                    "BR2_PACKAGE_GZIP=y",
                    "BR2_PACKAGE_TAR=y",
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
                    "BR2_PACKAGE_WPA_SUPPLICANT_NL80211=y",
                    "BR2_PACKAGE_IW=y",
                    "BR2_PACKAGE_WIRELESS_TOOLS=y",
                    "BR2_PACKAGE_LINUX_FIRMWARE=y",
                    "BR2_PACKAGE_LINUX_FIRMWARE_BRCM_BCM43XXX=y",
                    "BR2_PACKAGE_BRCMFMAC_SDIO_FIRMWARE_RPI=y",
                    "BR2_PACKAGE_LIBEVDEV=y",
                    "BR2_CCACHE=y",
                    'BR2_CCACHE_DIR="/cache/ccache"',
                    "BR2_CCACHE_USE_BASEDIR=y",
                    'BR2_ROOTFS_OVERLAY="/work/overlay"',
                    'BR2_ROOTFS_POST_BUILD_SCRIPT="board/raspberrypizero2w-64/post-build.sh /work/post-build.sh"',
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
        buildroot["setupJsonResetFilePath"] = normalize_buildroot_setup_json_reset_file_path(
            buildroot.get("setupJsonResetFilePath"),
            default_if_missing=True,
        )
        bootstrap_data["buildroot"] = buildroot
        return SimpleNamespace(**bootstrap_data)

    @staticmethod
    def _write_build_script(path: Path, output_filename: str) -> None:
        tarball = f"buildroot-{BUILDROOT_VERSION}.tar.gz"
        path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \\
  bc bison build-essential ca-certificates cpio curl file flex git libncurses-dev \\
  make patch perl python3 unzip wget xz-utils ccache

mkdir -p /cache /work /artifacts /build/buildroot /build/output
if [ ! -f /build/buildroot/.frameos-buildroot-version ]; then
  curl -fsSL -o /cache/{tarball} https://buildroot.org/downloads/{tarball}
  tar -C /build/buildroot --strip-components=1 -xzf /cache/{tarball}
  printf '%s\\n' '{BUILDROOT_VERSION}' > /build/buildroot/.frameos-buildroot-version
fi
if [ -s /build/output/images/sdcard.img ]; then
  cp /build/output/images/sdcard.img /artifacts/{shlex.quote(output_filename)}
  chmod a+r /artifacts/{shlex.quote(output_filename)}
  exit 0
fi
make -C /build/buildroot O=/build/output {BUILDROOT_DEFCONFIG}
cat /work/frameos-buildroot.config >> /build/output/.config
make -C /build/buildroot O=/build/output olddefconfig
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
    ) -> None:
        await self._log("stdout", f"Running Buildroot {BUILDROOT_VERSION} for Raspberry Pi Zero 2 W")
        docker_cmd = " ".join(
            [
                "docker run --rm",
                f"-v {shlex.quote(str(temp_dir))}:/work",
                f"-v {shlex.quote(str(source_dir))}:/build/buildroot",
                f"-v {shlex.quote(str(output_dir))}:/build/output",
                f"-v {shlex.quote(str(cache_dir))}:/cache",
                f"-v {shlex.quote(str(artifact_dir))}:/artifacts",
                "-e FORCE_UNSAFE_CONFIGURE=1",
                shlex.quote(BUILDROOT_DOCKER_IMAGE),
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

    async def _log(self, type: str, line: str) -> None:
        await log(self.db, self.redis, int(self.frame.id), type, line)

    @staticmethod
    def _buildroot_output_cache_key(
        build_id: str,
        overlay_dir: Path,
        config_path: Path,
        post_build_path: Path,
    ) -> str:
        def normalize_path(value: str) -> str:
            return value.replace(f"release_{build_id}", "release_$BUILD_ID")

        digest = hashlib.sha256()
        digest.update(f"buildroot-version={BUILDROOT_VERSION}\n".encode("utf-8"))
        digest.update(f"buildroot-defconfig={BUILDROOT_DEFCONFIG}\n".encode("utf-8"))
        digest.update(f"buildroot-docker-image={BUILDROOT_DOCKER_IMAGE}\n".encode("utf-8"))
        for path in (config_path, post_build_path):
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
mkdir -p "$target_dir/etc/systemd/system/multi-user.target.wants"

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


def _hostname_for_frame(frame: Frame) -> str:
    host = (frame.frame_host or f"frame{frame.id}").split(".", 1)[0]
    safe = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in host.lower()).strip("-")
    return safe or f"frame{frame.id}"
