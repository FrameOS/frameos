from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import partial
import os
import shlex
from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.codegen.drivers_nim import COMPILATION_MODE_PRECOMPILED, normalize_compilation_mode
from app.models.assets import sync_assets
from app.models.frame import Frame, normalize_https_proxy, normalize_reboot_crontab, update_frame
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryBuildResult, FrameBinaryPlan
from app.tasks.frame_deploy_helpers import (
    DEFAULT_QUICKJS_VERSION,
    ensure_lgpio,
    ensure_ntp_installed,
    ensure_quickjs,
    ensure_sudo_available,
    icon,
    install_if_necessary,
    sync_vendor_dir,
    upload_binary,
)
from app.tasks.setup_json_reset import (
    SETUP_JSON_RESET_SCRIPT_NAME,
    SETUP_JSON_RESET_SCRIPT_PATH,
    SETUP_JSON_RESET_SERVICE_NAME,
    SETUP_JSON_RESET_SERVICE_PATH,
    render_setup_json_reset_script,
    render_setup_json_reset_service,
    setup_json_reset_file_path,
)
from app.utils.frame_http import _fetch_frame_http_bytes
from app.utils.remote_exec import upload_file
from app.utils.ssh_authorized_keys import _install_authorized_keys
from app.utils.ssh_key_utils import normalize_ssh_keys, select_ssh_keys_for_frame
from app.utils.versions import current_frameos_version

REMOTE_RUNTIME_APT_PACKAGES = (
    "hostapd",
    "imagemagick",
)
REMOTE_BUILD_APT_PACKAGES = ("build-essential",)

HELPER_ENSURE_NTP = "ensure_ntp"
FRAMEOS_AVAILABLE_COMMANDS = ("start", "check", "setup", "help")
REMOTE_BUILD_FEATURE_CFLAGS = {
    "amd64": ("-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"),
    "x86_64": ("-mavx2", "-mavx", "-msse4.1", "-mssse3", "-mpclmul", "-mvpclmulqdq"),
}
def _deploy_uses_agent(frame: Frame) -> bool:
    agent = frame.agent if isinstance(frame.agent, dict) else {}
    return bool(
        agent.get("agentEnabled")
        and agent.get("agentRunCommands")
        and agent.get("deployWithAgent") is not False
    )


def _mountpoints_enabled(frame: Frame) -> bool:
    raw_mountpoints = getattr(frame, "mountpoints", None)
    mountpoints = raw_mountpoints if isinstance(raw_mountpoints, dict) else {}
    if not mountpoints.get("enabled"):
        return False

    for item in mountpoints.get("items") or []:
        if not isinstance(item, dict) or item.get("enabled") is False:
            continue
        if str(item.get("source") or "").strip() and str(item.get("target") or "").strip():
            return True
    return False


def _is_buildroot_frame(frame: Frame) -> bool:
    return (getattr(frame, "mode", None) or "rpios") == "buildroot"


def _mode_for_detected_distro(distro: str) -> str | None:
    if distro == "buildroot":
        return "buildroot"
    if distro in {"raspios", "debian", "ubuntu"}:
        return "rpios"
    return None


@dataclass(slots=True)
class PackagePlan:
    name: str
    reason: str
    installed: bool
    run_after_install: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "reason": self.reason,
            "installed": self.installed,
            "needs_install": not self.installed,
        }


@dataclass(slots=True)
class PackageAlternativePlan:
    names: list[str]
    reason: str
    installed_package: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "names": self.names,
            "reason": self.reason,
            "installed_package": self.installed_package,
            "satisfied": self.installed_package is not None,
        }


@dataclass(slots=True)
class HelperActionPlan:
    helper: str
    reason: str


@dataclass(slots=True)
class VendorSyncPlan:
    key: str
    vendor_folder: str
    label: str
    preserve_remote_paths: tuple[str, ...] = field(default_factory=tuple)


@dataclass(slots=True)
class FastDeployPlan:
    reload_supported: bool
    tls_settings_changed: bool
    action: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "reload_supported": self.reload_supported,
            "tls_settings_changed": self.tls_settings_changed,
            "action": self.action,
        }


@dataclass(slots=True)
class FullDeployPlan:
    target: dict[str, Any]
    low_memory: bool
    drivers: list[str]
    binary_plan: FrameBinaryPlan
    package_plans: list[PackagePlan] = field(default_factory=list)
    package_alternatives: list[PackageAlternativePlan] = field(default_factory=list)
    dependency_helper_plans: list[HelperActionPlan] = field(default_factory=list)
    remote_build_fallback_package_plans: list[PackagePlan] = field(default_factory=list)
    vendor_sync_plans: list[VendorSyncPlan] = field(default_factory=list)
    lgpio_required: bool = False
    lgpio_installed: bool = False
    quickjs_required_if_remote_build: bool = False
    quickjs_dirname: str | None = None
    quickjs_installed: bool = False
    ssh_keys_need_install: bool = False
    selected_public_keys: list[str] = field(default_factory=list)
    known_public_keys: list[str] = field(default_factory=list)
    post_deploy: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "low_memory": self.low_memory,
            "drivers": self.drivers,
            "binary": self.binary_plan.to_dict(),
            "packages": [pkg.to_dict() for pkg in self.package_plans],
            "package_alternatives": [pkg.to_dict() for pkg in self.package_alternatives],
            "lgpio": {
                "required": self.lgpio_required,
                "installed": self.lgpio_installed,
            },
            "quickjs": {
                "required_if_remote_build": self.quickjs_required_if_remote_build,
                "dirname": self.quickjs_dirname,
                "installed": self.quickjs_installed,
            },
            "ssh_keys_need_install": self.ssh_keys_need_install,
            "post_deploy": self.post_deploy,
        }


@dataclass(slots=True)
class FrameDeployPlan:
    mode: str
    frame_id: int
    frame_name: str
    build_id: str
    frame_dict: dict[str, Any]
    previous_frameos_version: str | None
    full_deploy: FullDeployPlan | None = None
    fast_deploy: FastDeployPlan | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "frame_id": self.frame_id,
            "frame_name": self.frame_name,
            "build_id": self.build_id,
            "previous_frameos_version": self.previous_frameos_version,
            "notes": self.notes,
            "fast_deploy": self.fast_deploy.to_dict() if self.fast_deploy else None,
            "full_deploy": self.full_deploy.to_dict() if self.full_deploy else None,
        }


def tls_settings_changed(frame: Frame) -> bool:
    if not frame.last_successful_deploy:
        return False

    previous_deploy = frame.last_successful_deploy or {}
    previous_proxy = normalize_https_proxy(previous_deploy.get("https_proxy"))
    current_proxy = normalize_https_proxy(frame.https_proxy)
    return previous_proxy != current_proxy


class FrameDeployWorkflow:
    def __init__(
        self,
        *,
        db: Session,
        redis: Redis,
        frame: Frame,
        deployer: FrameDeployer,
        temp_dir: str,
        binary_builder: FrameBinaryBuilder | None = None,
    ) -> None:
        self.db = db
        self.redis = redis
        self.frame = frame
        self.deployer = deployer
        self.temp_dir = temp_dir
        self.binary_builder = binary_builder or FrameBinaryBuilder(
            db=db,
            redis=redis,
            frame=frame,
            deployer=deployer,
            temp_dir=temp_dir,
        )

    def _previous_frameos_commands(self) -> list[str]:
        previous_deploy = self.frame.last_successful_deploy
        if not isinstance(previous_deploy, dict):
            return []
        commands = previous_deploy.get("frameos_commands")
        if not isinstance(commands, list):
            return []
        return [command for command in commands if isinstance(command, str)]

    def _current_frameos_supports_command(self, command: str) -> bool:
        return command in self._previous_frameos_commands()

    async def _sync_frame_mode_with_detected_distro(self, distro: str) -> None:
        detected_mode = _mode_for_detected_distro(distro)
        if not detected_mode or (getattr(self.frame, "mode", None) or "rpios") == detected_mode:
            return

        previous_mode = getattr(self.frame, "mode", None) or "rpios"
        self.frame.mode = detected_mode
        if (
            previous_mode == "buildroot"
            and detected_mode == "rpios"
            and getattr(self.frame, "ssh_user", None) == "root"
        ):
            self.frame.ssh_user = "pi"
        message = f"{icon} Detected {distro}; updating frame deployment mode from {previous_mode} to {detected_mode}"
        if self.db is not None and self.redis is not None:
            await log(self.db, self.redis, int(self.frame.id), "stdinfo", message)
        else:
            await self.deployer.log("stdinfo", message)
        if isinstance(self.frame, Frame) and self.db is not None and self.redis is not None:
            await update_frame(self.db, self.redis, self.frame)

    async def plan(self, mode: str) -> FrameDeployPlan:
        frame_dict = self.frame.to_dict()
        frame_dict.pop("last_successful_deploy", None)
        frame_dict.pop("last_successful_deploy_at", None)
        previous_frameos_version = (self.frame.last_successful_deploy or {}).get("frameos_version")

        if mode == "combined":
            return await self._plan_combined(frame_dict=frame_dict, previous_frameos_version=previous_frameos_version)
        if mode == "fast":
            return await self._plan_fast(frame_dict=frame_dict, previous_frameos_version=previous_frameos_version)
        if mode == "full":
            return await self._plan_full(frame_dict=frame_dict, previous_frameos_version=previous_frameos_version)
        raise ValueError(f"Unsupported deploy mode: {mode}")

    async def execute(self, plan: FrameDeployPlan) -> None:
        if plan.mode == "fast":
            await self._execute_fast(plan)
            return
        if plan.mode == "full":
            await self._execute_full(plan)
            return
        raise ValueError(f"Unsupported deploy mode: {plan.mode}")

    async def _plan_combined(
        self,
        *,
        frame_dict: dict[str, Any],
        previous_frameos_version: str | None,
    ) -> FrameDeployPlan:
        fast_plan = await self._plan_fast(frame_dict=dict(frame_dict), previous_frameos_version=previous_frameos_version)
        full_plan = await self._plan_full(frame_dict=dict(frame_dict), previous_frameos_version=previous_frameos_version)

        notes = [
            "Fast deploy keeps the frame configuration and interpreted scenes up to date without rebuilding FrameOS.",
            "Full deploy additionally rebuilds or uploads the FrameOS binary, installs any missing dependencies, and applies system-level changes.",
            *fast_plan.notes,
            *[note for note in full_plan.notes if note not in fast_plan.notes],
        ]

        return FrameDeployPlan(
            mode="combined",
            frame_id=int(self.frame.id),
            frame_name=self.frame.name,
            build_id=self.deployer.build_id,
            frame_dict=full_plan.frame_dict,
            previous_frameos_version=previous_frameos_version if isinstance(previous_frameos_version, str) else None,
            fast_deploy=fast_plan.fast_deploy,
            full_deploy=full_plan.full_deploy,
            notes=notes,
        )

    async def _plan_fast(self, *, frame_dict: dict[str, Any], previous_frameos_version: str | None) -> FrameDeployPlan:
        distro = await self.deployer.get_distro()
        await self._sync_frame_mode_with_detected_distro(distro)
        frame_dict["mode"] = getattr(self.frame, "mode", frame_dict.get("mode"))
        frame_dict["ssh_user"] = getattr(self.frame, "ssh_user", frame_dict.get("ssh_user"))
        if distro not in {"raspios", "debian", "ubuntu", "buildroot"}:
            raise Exception(f"Unsupported target distro '{distro}'")

        tls_changed = tls_settings_changed(self.frame)
        fast_plan = FastDeployPlan(
            reload_supported=not tls_changed,
            tls_settings_changed=tls_changed,
            action="restart_service" if tls_changed else "reload_then_restart_on_failure",
        )

        if isinstance(previous_frameos_version, str):
            frame_dict["frameos_version"] = previous_frameos_version
        else:
            frame_dict["frameos_version"] = current_frameos_version()
        previous_commands = self._previous_frameos_commands()
        if previous_commands:
            frame_dict["frameos_commands"] = previous_commands

        notes = [
            f"Detected distro: {distro}",
            "Fast deploy updates frame metadata and scene payloads, runs FrameOS setup when supported, then reloads FrameOS.",
        ]
        if tls_changed:
            notes.append("TLS settings changed; plan will restart FrameOS instead of using the reload endpoint.")
        return FrameDeployPlan(
            mode="fast",
            frame_id=int(self.frame.id),
            frame_name=self.frame.name,
            build_id=self.deployer.build_id,
            frame_dict=frame_dict,
            previous_frameos_version=previous_frameos_version if isinstance(previous_frameos_version, str) else None,
            fast_deploy=fast_plan,
            notes=notes,
        )

    async def _plan_full(self, *, frame_dict: dict[str, Any], previous_frameos_version: str | None) -> FrameDeployPlan:
        arch = await self.deployer.get_cpu_architecture()
        distro = await self.deployer.get_distro()
        distro_version = await self.deployer.get_distro_version()
        total_memory = await self.deployer.get_total_memory_mb()
        low_memory = total_memory < 512

        await self._sync_frame_mode_with_detected_distro(distro)
        frame_dict["mode"] = getattr(self.frame, "mode", frame_dict.get("mode"))
        frame_dict["ssh_user"] = getattr(self.frame, "ssh_user", frame_dict.get("ssh_user"))
        is_buildroot = _is_buildroot_frame(self.frame)
        if distro not in {"raspios", "debian", "ubuntu"} and not (is_buildroot and distro == "buildroot"):
            raise Exception(f"Unsupported target distro '{distro}'")
        frame_dict["frameos_version"] = current_frameos_version()
        frame_dict["frameos_commands"] = list(FRAMEOS_AVAILABLE_COMMANDS)

        drivers = drivers_for_frame(self.frame)
        driver_names = sorted(drivers.keys())

        compile_settings = (self.frame.buildroot if is_buildroot else self.frame.rpios) or {}
        cross_compilation_setting = (
            "always" if is_buildroot else (compile_settings.get("crossCompilation") or "auto").lower()
        )
        if cross_compilation_setting not in {"auto", "always", "never"}:
            cross_compilation_setting = "auto"
        compilation_mode = normalize_compilation_mode(compile_settings.get("compilationMode"))

        allow_cross_compile = cross_compilation_setting != "never"
        force_cross_compile = is_buildroot or cross_compilation_setting == "always"
        binary_plan = await self.binary_builder.plan_build(
            allow_cross_compile=allow_cross_compile,
            force_cross_compile=force_cross_compile,
            compilation_mode=compilation_mode,
        )

        settings = get_settings_dict(self.db)
        selected_keys = select_ssh_keys_for_frame(self.frame, settings)
        selected_public_keys = [key.get("public") for key in selected_keys if key.get("public")]
        known_public_keys = [key.get("public") for key in normalize_ssh_keys(settings) if key.get("public")]
        previous_ssh_keys = self.frame.last_successful_deploy.get("ssh_keys") if isinstance(self.frame.last_successful_deploy, dict) else None
        ssh_keys_need_install = list(getattr(self.frame, "ssh_keys", None) or []) != list(previous_ssh_keys or [])

        package_plans: list[PackagePlan] = []
        package_alternatives = (
            []
            if is_buildroot
            else [
                await self._plan_package_alternatives(["ntp", "ntpsec"], "time synchronization"),
            ]
        )
        dependency_helper_plans = [
            HelperActionPlan(helper=HELPER_ENSURE_NTP, reason=alternative.reason)
            for alternative in package_alternatives
            if alternative.names == ["ntp", "ntpsec"] and not alternative.installed_package
        ]
        remote_build_fallback_package_plans: list[PackagePlan] = []

        if not is_buildroot:
            for pkg_name in REMOTE_RUNTIME_APT_PACKAGES:
                package_plans.append(await self._plan_package(pkg_name, "base remote deploy dependency"))

        if not is_buildroot and not binary_plan.will_attempt_precompiled:
            for pkg_name in REMOTE_BUILD_APT_PACKAGES:
                package_plans.append(await self._plan_package(pkg_name, "base remote build dependency"))
            if not binary_plan.will_attempt_cross_compile:
                package_plans.append(await self._plan_package("libssl-dev", "OpenSSL headers for on-device FrameOS build"))
            else:
                remote_build_fallback_package_plans.append(
                    await self._plan_package("libssl-dev", "OpenSSL headers if cross-compilation falls back to an on-device build")
                )
        if not is_buildroot:
            package_plans.append(
                await self._plan_package(
                    "caddy",
                    "FrameOS TLS proxy support",
                    run_after_install="sudo systemctl disable --now caddy.service",
                )
            )

        if not is_buildroot and _mountpoints_enabled(self.frame):
            package_plans.append(await self._plan_package("cifs-utils", "Samba/CIFS mountpoint support"))

        if not is_buildroot and drivers.get("evdev"):
            package_plans.append(await self._plan_package("libevdev-dev", "evdev driver support"))

        lgpio_required = bool(
            drivers.get("waveshare")
            or drivers.get("inky")
            or drivers.get("gpioButton")
            or drivers.get("inkyHyperPixel2r")
        )
        lgpio_installed = False
        if lgpio_required and is_buildroot:
            lgpio_installed = True
        elif lgpio_required:
            lgpio_installed = await self._path_exists("/usr/local/include/lgpio.h") or await self._path_exists(
                "/usr/include/lgpio.h"
            )
            if not lgpio_installed:
                package_plans.append(await self._plan_package("liblgpio-dev", "GPIO/Waveshare/HyperPixel driver support"))

        if not is_buildroot and drivers.get("inkyPython"):
            package_plans.extend(
                [
                    await self._plan_package("python3-pip", "inkyPython vendor setup"),
                    await self._plan_package("python3-venv", "inkyPython vendor setup"),
                ]
            )
        if not is_buildroot and drivers.get("inkyHyperPixel2rLegacyFb"):
            package_plans.extend(
                [
                    await self._plan_package("python3-dev", "inkyHyperPixel2r legacy vendor setup"),
                    await self._plan_package("python3-pip", "inkyHyperPixel2r legacy vendor setup"),
                    await self._plan_package("python3-venv", "inkyHyperPixel2r legacy vendor setup"),
                ]
            )

        vendor_sync_plans: list[VendorSyncPlan] = []
        if inky_python := drivers.get("inkyPython"):
            vendor_sync_plans.append(
                VendorSyncPlan(
                    key="inkyPython",
                    vendor_folder=inky_python.vendor_folder or "",
                    label="inkyPython vendor files",
                    preserve_remote_paths=("env", "requirements.txt.sha256sum"),
                )
            )
        if inky_hyperpixel := drivers.get("inkyHyperPixel2rLegacyFb"):
            vendor_sync_plans.append(
                VendorSyncPlan(
                    key="inkyHyperPixel2rLegacyFb",
                    vendor_folder=inky_hyperpixel.vendor_folder or "",
                    label="inkyHyperPixel2r legacy vendor files",
                    preserve_remote_paths=("env", "requirements.txt.sha256sum"),
                )
            )

        quickjs_required_if_remote_build = not is_buildroot and not force_cross_compile and not binary_plan.will_attempt_precompiled
        quickjs_dirname = None
        quickjs_installed = False
        if quickjs_required_if_remote_build:
            quickjs_version = (
                binary_plan.prebuilt_entry.version_for("quickjs", DEFAULT_QUICKJS_VERSION)
                if binary_plan.prebuilt_entry
                else DEFAULT_QUICKJS_VERSION
            )
            quickjs_dirname = f"quickjs-{quickjs_version}"
            quickjs_installed = await self._path_exists(f"/srv/frameos/vendor/quickjs/{quickjs_dirname}")
            if not quickjs_installed and not binary_plan.will_attempt_cross_compile:
                for pkg_name in (
                    "libunistring-dev",
                    "libtool",
                    "cmake",
                    "pkg-config",
                    "libatomic-ops-dev",
                    "libicu-dev",
                    "zlib1g-dev",
                ):
                    package_plans.append(await self._plan_package(pkg_name, "QuickJS build dependency"))

        notes = [
            f"Detected distro: {distro} ({distro_version}), architecture: {arch}, total memory: {total_memory} MiB",
            f"Cross compilation setting: {cross_compilation_setting}",
            f"Compilation mode: {compilation_mode}",
        ]
        if compilation_mode == COMPILATION_MODE_PRECOMPILED:
            if binary_plan.will_attempt_precompiled:
                notes.append("Precompiled FrameOS release will be used because all scenes are interpreted.")
            else:
                fallback = "single executable"
                if binary_plan.compilation_mode == "shared-scenes":
                    fallback = "compiled scenes library"
                elif binary_plan.compilation_mode == "shared":
                    fallback = "shared libraries"
                notes.append(
                    "Precompiled FrameOS release will be skipped"
                    + (
                        f": {binary_plan.precompiled_skip_reason}."
                        if binary_plan.precompiled_skip_reason
                        else "."
                    )
                    + f" Falling back to {fallback}."
                )
        if low_memory and not binary_plan.will_attempt_precompiled:
            notes.append("Device is low memory; on-device build path will stop FrameOS before compilation.")
        if not selected_public_keys:
            notes.append("No SSH public keys selected for deployment.")
        elif ssh_keys_need_install:
            notes.append("SSH public keys changed since the last deploy and will be installed on the frame.")

        post_deploy = await self._plan_post_deploy_cleanup(drivers=drivers, low_memory=low_memory)

        return FrameDeployPlan(
            mode="full",
            frame_id=int(self.frame.id),
            frame_name=self.frame.name,
            build_id=self.deployer.build_id,
            frame_dict=frame_dict,
            previous_frameos_version=previous_frameos_version if isinstance(previous_frameos_version, str) else None,
            full_deploy=FullDeployPlan(
                target={
                    "arch": arch,
                    "distro": distro,
                    "version": distro_version,
                    "total_memory_mb": total_memory,
                },
                low_memory=low_memory,
                drivers=driver_names,
                binary_plan=binary_plan,
                package_plans=package_plans,
                package_alternatives=package_alternatives,
                dependency_helper_plans=dependency_helper_plans,
                remote_build_fallback_package_plans=remote_build_fallback_package_plans,
                vendor_sync_plans=vendor_sync_plans,
                lgpio_required=lgpio_required,
                lgpio_installed=lgpio_installed,
                quickjs_required_if_remote_build=quickjs_required_if_remote_build,
                quickjs_dirname=quickjs_dirname,
                quickjs_installed=quickjs_installed,
                ssh_keys_need_install=ssh_keys_need_install,
                selected_public_keys=selected_public_keys,
                known_public_keys=known_public_keys,
                post_deploy=post_deploy,
            ),
            notes=notes,
        )

    async def _execute_fast(self, plan: FrameDeployPlan) -> None:
        frame = self.frame
        frame.status = "deploying"
        await update_frame(self.db, self.redis, frame)

        try:
            await self.deployer._upload_frame_json_atomically("/srv/frameos/current/frame.json")
            await self.deployer._upload_scenes_json_atomically("/srv/frameos/current/scenes.json.gz", gzip=True)
            await self.deployer._upload_all_scenes_json_atomically("/srv/frameos/current/all_scenes.json.gz", gzip=True)

            if not plan.fast_deploy:
                raise RuntimeError("Fast deploy plan missing")

            setup_requires_reboot = await self._run_current_setup()
            if setup_requires_reboot:
                frame.status = "starting"
                frame.last_successful_deploy = plan.frame_dict
                frame.last_successful_deploy_at = datetime.now(timezone.utc)
                await update_frame(self.db, self.redis, frame)
                await self.deployer.exec_command("sudo systemctl enable frameos.service")
                await log(self.db, self.redis, int(frame.id), "stdinfo", f"{icon} Deployed! Rebooting device after setup changes")
                await self.deployer.exec_command("sudo reboot")
                return

            if plan.fast_deploy.tls_settings_changed:
                await log(self.db, self.redis, int(frame.id), "stdout", "- TLS settings changed, restarting FrameOS service")
                await self.deployer.restart_service("frameos")
            else:
                try:
                    status, body, _headers = await _fetch_frame_http_bytes(frame, self.redis, path="/reload", method="POST")
                    if status >= 300:
                        message = body.decode("utf-8", errors="replace")
                        await log(self.db, self.redis, int(frame.id), "stderr", f"Reload failed with status {status}: {message}. Restarting service.")
                        await self.deployer.restart_service("frameos")
                except Exception as exc:
                    await log(self.db, self.redis, int(frame.id), "stderr", f"Reload request failed: {str(exc)}. Restarting service.")
                    await self.deployer.restart_service("frameos")

            frame.status = "starting"
            frame.last_successful_deploy = plan.frame_dict
            frame.last_successful_deploy_at = datetime.now(timezone.utc)
            await update_frame(self.db, self.redis, frame)
        except Exception:
            frame.status = "uninitialized"
            await update_frame(self.db, self.redis, frame)
            raise

    async def _execute_full(self, plan: FrameDeployPlan) -> None:
        if self.frame.status == "deploying":
            await self._mark_stuck_deploy_as_undeployed()
            return
        if not plan.full_deploy:
            raise RuntimeError("Full deploy plan missing")

        full_plan = plan.full_deploy
        frame = self.frame
        frame.status = "deploying"
        await update_frame(self.db, self.redis, frame)
        build_id = plan.build_id
        stopped_frameos_for_setup = False

        await self.deployer.log("stdout", f"{icon} Deploying frame {frame.name} with build id {build_id}")

        try:
            await ensure_sudo_available(self.deployer)
            await self._install_authorized_keys_for_full_deploy(full_plan)
            build_result = await self._build_full_release_binary(full_plan)
            quickjs_dirname = await self._prepare_remote_for_full_release(
                full_plan=full_plan,
                build_result=build_result,
                build_id=build_id,
            )
            await self._prepare_release_directory(build_id)
            await self._publish_release_binary(
                build_result=build_result,
                build_id=build_id,
                quickjs_dirname=quickjs_dirname,
            )
            await self._upload_release_metadata(build_id)
            await self._sync_vendor_dependencies(
                full_plan=full_plan,
                build_result=build_result,
                build_id=build_id,
            )
            stopped_frameos_for_setup = await self._stop_frameos_for_release_setup()
            await self._run_release_setup(build_id=build_id, post_deploy=full_plan.post_deploy)
            await sync_assets(self.db, self.redis, frame)
            await self._cleanup_release_artifacts()
            await self._run_post_deploy_cleanup(post_deploy=full_plan.post_deploy)

            frame.status = "starting"
            plan.frame_dict["frameos_version"] = current_frameos_version()
            plan.frame_dict["frameos_commands"] = list(FRAMEOS_AVAILABLE_COMMANDS)
            frame.last_successful_deploy = plan.frame_dict
            frame.last_successful_deploy_at = datetime.now(timezone.utc)
            await update_frame(self.db, self.redis, frame)
        except Exception:
            frame.status = "uninitialized"
            await update_frame(self.db, self.redis, frame)
            if stopped_frameos_for_setup:
                try:
                    await self.deployer.log("stdout", f"{icon} Restarting previous FrameOS service after failed deploy")
                    await self.deployer.restart_service("frameos")
                except Exception as restart_error:
                    await self.deployer.log(
                        "stderr",
                        f"Failed to restart previous FrameOS service after failed deploy: {restart_error}",
                    )
            raise

    async def _mark_stuck_deploy_as_undeployed(self) -> None:
        self.frame.status = "uninitialized"
        await update_frame(self.db, self.redis, self.frame)
        await self.deployer.log("stderr", "Already deploying. Marked frame as undeployed; request deploy again to start fresh.")

    async def _install_authorized_keys_for_full_deploy(self, full_plan: FullDeployPlan) -> None:
        if full_plan.selected_public_keys and full_plan.ssh_keys_need_install:
            if _deploy_uses_agent(self.frame):
                await self.deployer.log(
                    "stdout",
                    f"{icon} Agent deploy selected; skipping SSH authorized_keys install",
                )
                return
            await self.deployer.log("stdout", f"{icon} Checking SSH keys on device")
            await _install_authorized_keys(
                self.db,
                self.redis,
                self.frame,
                full_plan.selected_public_keys,
                full_plan.known_public_keys,
            )
        elif not full_plan.selected_public_keys:
            await self.deployer.log("stdout", f"{icon} No SSH public keys configured; skipping authorized_keys install")
        else:
            await self.deployer.log("stdout", f"{icon} SSH public keys already match the last deploy; skipping authorized_keys install")

    async def _build_full_release_binary(self, full_plan: FullDeployPlan) -> FrameBinaryBuildResult:
        return await self.binary_builder.build(full_plan.binary_plan)

    async def _prepare_remote_for_full_release(
        self,
        *,
        full_plan: FullDeployPlan,
        build_result: FrameBinaryBuildResult,
        build_id: str,
    ) -> str | None:
        await self._stop_frameos_for_remote_build_if_needed(
            full_plan=full_plan,
            cross_compiled=build_result.cross_compiled,
        )
        await self._install_planned_remote_dependencies(
            full_plan=full_plan,
            cross_compiled=build_result.cross_compiled,
        )
        await ensure_lgpio(
            self.deployer,
            required=full_plan.lgpio_required,
            prebuilt_entry=build_result.prebuilt_entry,
            already_installed=full_plan.lgpio_installed,
        )
        return await ensure_quickjs(
            self.deployer,
            prebuilt_entry=build_result.prebuilt_entry,
            build_id=build_id,
            cross_compiled=build_result.cross_compiled,
            quickjs_installed=full_plan.quickjs_installed,
            quickjs_dirname=full_plan.quickjs_dirname or f"quickjs-{DEFAULT_QUICKJS_VERSION}",
        )

    async def _stop_frameos_for_remote_build_if_needed(self, *, full_plan: FullDeployPlan, cross_compiled: bool) -> None:
        if full_plan.low_memory and not cross_compiled:
            await self.deployer.log("stdout", f"{icon} Low memory device, stopping FrameOS for compilation")
            await self.deployer.exec_command("sudo service frameos stop", raise_on_error=False)

    async def _install_planned_remote_dependencies(self, *, full_plan: FullDeployPlan, cross_compiled: bool) -> None:
        await self.deployer.log("stdout", f"{icon} Installing dependencies on remote")
        await self._run_dependency_helper_plans(full_plan.dependency_helper_plans)
        await self._install_package_plans(full_plan.package_plans)
        if not cross_compiled:
            await self._install_package_plans(full_plan.remote_build_fallback_package_plans)

    async def _run_dependency_helper_plans(self, helper_plans: list[HelperActionPlan]) -> None:
        for helper_plan in helper_plans:
            if helper_plan.helper == HELPER_ENSURE_NTP:
                await ensure_ntp_installed(self.deployer)
                continue
            raise ValueError(f"Unknown dependency helper plan: {helper_plan.helper}")

    async def _install_package_plans(self, package_plans: list[PackagePlan]) -> None:
        install_package = partial(install_if_necessary, self.deployer)
        for package_plan in package_plans:
            if package_plan.installed:
                continue
            await install_package(
                package_plan.name,
                run_after_install=package_plan.run_after_install,
            )

    async def _prepare_release_directory(self, build_id: str) -> None:
        await self.deployer.exec_command("sudo mkdir -p /srv/frameos && sudo chown $(whoami):$(whoami) /srv/frameos")
        await self.deployer.exec_command("mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
        await self.deployer.exec_command(f"mkdir -p {self._release_dir(build_id)}")

    async def _publish_release_binary(
        self,
        *,
        build_result: FrameBinaryBuildResult,
        build_id: str,
        quickjs_dirname: str | None,
    ) -> None:
        release_frameos_path = self._release_frameos_path(build_id)
        if build_result.cross_compiled:
            await self._publish_cross_compiled_binary(build_result, release_frameos_path)
            await self._publish_cross_compiled_driver_libraries(build_result, build_id)
            return
        await self._publish_remote_built_binary(build_result, build_id, release_frameos_path, quickjs_dirname)

    async def _publish_cross_compiled_binary(
        self,
        build_result: FrameBinaryBuildResult,
        release_frameos_path: str,
    ) -> None:
        message = "Using precompiled FrameOS binary" if build_result.precompiled else "Using cross-compiled binary"
        await self.deployer.log("stdout", f"{icon} {message}")
        if not build_result.binary_path:
            raise RuntimeError("Cross compilation succeeded but binary path is unknown")
        await upload_binary(self.deployer, build_result.binary_path, release_frameos_path)

    async def _publish_cross_compiled_driver_libraries(
        self,
        build_result: FrameBinaryBuildResult,
        build_id: str,
    ) -> None:
        await self._publish_cross_compiled_libraries(
            local_paths=build_result.driver_library_paths,
            label="driver",
            remote_dir=self._release_driver_dir(build_id),
        )
        await self._publish_cross_compiled_libraries(
            local_paths=build_result.scene_library_paths,
            label="scene",
            remote_dir=self._release_scene_dir(build_id),
        )

    async def _publish_cross_compiled_libraries(
        self,
        *,
        local_paths: list[str],
        label: str,
        remote_dir: str,
    ) -> None:
        if not local_paths:
            return
        await self.deployer.log("stdout", f"{icon} Uploading shared {label} libraries")
        await self.deployer.exec_command(f"mkdir -p {shlex.quote(remote_dir)}")
        for local_path in local_paths:
            if not os.path.isfile(local_path):
                raise RuntimeError(f"Shared {label} library missing after cross compilation: {local_path}")
            remote_path = f"{remote_dir}/{os.path.basename(local_path)}"
            await upload_binary(self.deployer, local_path, remote_path)

    async def _publish_remote_built_binary(
        self,
        build_result: FrameBinaryBuildResult,
        build_id: str,
        release_frameos_path: str,
        quickjs_dirname: str | None,
    ) -> None:
        await self.deployer.log("stdout", f"{icon} Building FrameOS on remote, no cross-compilation")
        remote_archive_path = self._remote_build_archive_path(build_id)
        remote_build_dir = self._remote_build_dir(build_id)
        await self.deployer.log("stdout", f"> add {remote_archive_path}")

        with open(build_result.archive_path, "rb") as fh:
            data = fh.read()
        await upload_file(
            self.deployer.db,
            self.deployer.redis,
            self.deployer.frame,
            remote_archive_path,
            data,
        )

        await self.deployer.exec_command(
            f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz"
        )
        if quickjs_dirname:
            await self.deployer.exec_command(
                f"ln -s /srv/frameos/vendor/quickjs/{quickjs_dirname} {remote_build_dir}/quickjs",
            )
        extra_cflags = " ".join(REMOTE_BUILD_FEATURE_CFLAGS.get(build_result.target.arch.lower(), ()))
        make_prefix = f"EXTRA_CFLAGS={shlex.quote(extra_cflags)} " if extra_cflags else ""
        await self.deployer.exec_command(
            f"cd {remote_build_dir} && "
            "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
            "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
            f"{make_prefix}make -j$PARALLEL",
            timeout=3600,
        )
        await self.deployer.exec_command(
            f"cp {remote_build_dir}/frameos {release_frameos_path}"
        )
        for local_paths, release_dir in (
            (build_result.driver_library_paths, self._release_driver_dir(build_id)),
            (build_result.scene_library_paths, self._release_scene_dir(build_id)),
        ):
            if not local_paths:
                continue
            await self.deployer.exec_command(f"mkdir -p {shlex.quote(release_dir)}")
            for local_path in local_paths:
                relative_path = os.path.relpath(local_path, build_result.build_dir)
                remote_source = f"{remote_build_dir}/{relative_path}"
                remote_dest = f"{release_dir}/{os.path.basename(local_path)}"
                await self.deployer.exec_command(
                    f"cp {shlex.quote(remote_source)} {shlex.quote(remote_dest)}"
                )

    async def _upload_release_metadata(self, build_id: str) -> None:
        await self.deployer._upload_scenes_json(f"{self._release_dir(build_id)}/scenes.json.gz", gzip=True)
        await self.deployer._upload_all_scenes_json(f"{self._release_dir(build_id)}/all_scenes.json.gz", gzip=True)
        await self.deployer._upload_frame_json(f"{self._release_dir(build_id)}/frame.json")

    async def _sync_vendor_dependencies(
        self,
        *,
        full_plan: FullDeployPlan,
        build_result: FrameBinaryBuildResult,
        build_id: str,
    ) -> None:
        for vendor_plan in full_plan.vendor_sync_plans:
            await sync_vendor_dir(
                self.deployer,
                os.path.join(build_result.build_dir, "vendor", vendor_plan.vendor_folder),
                vendor_plan.vendor_folder,
                vendor_plan.label,
                build_result.cross_compiled,
                build_id,
                vendor_plan.preserve_remote_paths,
            )

    async def _run_release_setup(self, *, build_id: str, post_deploy: dict[str, Any]) -> None:
        setup_requires_reboot = await self._run_setup_in_directory(self._release_dir(build_id))
        if setup_requires_reboot:
            post_deploy["final_action"] = "reboot"

    async def _stop_frameos_for_release_setup(self) -> bool:
        await self.deployer.log("stdout", f"{icon} Stopping running FrameOS before device setup")
        statuses = [
            await self.deployer.exec_command("sudo service frameos stop", raise_on_error=False),
            await self.deployer.exec_command(
                "sudo sh -c 'killall frameos 2>/dev/null || true'",
                raise_on_error=False,
            ),
        ]
        if statuses[0] != 0:
            await self.deployer.log(
                "stderr",
                f"Could not stop FrameOS service before device setup; continuing with setup anyway (exit code {statuses[0]})",
            )
            return False
        return True

    async def _run_current_setup(self) -> bool:
        if not self._current_frameos_supports_command("setup"):
            await self.deployer.log(
                "stdout",
                f"{icon} Skipping FrameOS device setup; current FrameOS does not list the setup command",
            )
            return False
        return await self._run_setup_in_directory("/srv/frameos/current")

    async def _run_setup_in_directory(self, path: str) -> bool:
        await self.deployer.log("stdout", f"{icon} Running FrameOS device setup")
        root_remounted_rw = await self._remount_root_rw_for_setup_if_needed()
        try:
            setup_output: list[str] = []
            setup_status = await self.deployer.exec_command(
                f"cd {shlex.quote(path)} && sudo ./frameos setup",
                output=setup_output,
                raise_on_error=False,
                log_command="sudo ./frameos setup",
            )
        finally:
            if root_remounted_rw:
                await self._remount_root_ro_after_setup()
        if self._setup_completed_before_legacy_shared_driver_segfault(setup_status, setup_output):
            await self.deployer.log(
                "stderr",
                "FrameOS setup completed, then exited during legacy shared-driver teardown; continuing deploy.",
            )
            return False
        if self._setup_failed_after_buildroot_systemd_service_install(setup_status, setup_output):
            await self.deployer.log(
                "stderr",
                "FrameOS setup completed device changes but failed refreshing the Buildroot systemd service file; continuing deploy.",
            )
            return False
        if setup_status == 2:
            return True
        if setup_status != 0:
            await self._log_setup_failure_diagnostics(setup_status)
            raise RuntimeError(f"FrameOS setup failed with exit code {setup_status}")
        return False

    async def _remount_root_rw_for_setup_if_needed(self) -> bool:
        status = await self.deployer.exec_command(
            "awk '$2 == \"/\" { split($4, opts, \",\"); for (i in opts) if (opts[i] == \"ro\") found=1 } END { exit found ? 0 : 1 }' /proc/mounts",
            raise_on_error=False,
            log_output=False,
            log_command=False,
        )
        if status != 0:
            return False

        await self.deployer.log("stdout", "Root filesystem is read-only; remounting read-write for setup")
        await self.deployer.exec_command("sudo mount -o remount,rw /")
        return True

    async def _remount_root_ro_after_setup(self) -> None:
        await self.deployer.log("stdout", "Restoring root filesystem to read-only after setup")
        await self.deployer.exec_command("sudo sync", raise_on_error=False)
        await self.deployer.exec_command("sudo mount -o remount,ro /")

    @staticmethod
    def _setup_completed_before_legacy_shared_driver_segfault(setup_status: int, setup_output: list[str]) -> bool:
        if setup_status not in {-1, 139}:
            return False
        setup_failed = any(": failed:" in line for line in setup_output)
        if setup_failed:
            return False
        return any(
            line.strip() == "FrameOS setup: complete"
            or (line.startswith("FrameOS setup: shared driver ") and line.endswith(": setup complete"))
            for line in setup_output
        )

    def _setup_failed_after_buildroot_systemd_service_install(self, setup_status: int, setup_output: list[str]) -> bool:
        if setup_status == 0 or (getattr(self.frame, "mode", None) or "rpios") != "buildroot":
            return False

        driver_setup_complete = any(line.strip() == "FrameOS setup: driver setup: complete" for line in setup_output)
        installing_frameos_service = any(
            line.strip() == "FrameOS setup: systemd services: installing frameos.service"
            for line in setup_output
        )
        service_write_failed = any(
            "/etc/systemd/system/frameos.service" in line and "cannot open" in line
            for line in setup_output
        )
        return driver_setup_complete and installing_frameos_service and service_write_failed

    async def _log_setup_failure_diagnostics(self, setup_status: int) -> None:
        await self.deployer.log("stderr", f"FrameOS setup exited with code {setup_status}; collecting diagnostics")
        diagnostics = (
            ("memory usage", "free -m"),
            (
                "FrameOS processes",
                "ps -eo pid,ppid,stat,rss,comm,args | grep -E '[f]rameos|[f]rameos_agent'",
            ),
            ("kernel messages", "sudo sh -c 'dmesg -T 2>/dev/null || dmesg' | tail -80"),
        )
        for label, command in diagnostics:
            await self.deployer.exec_command(
                command,
                raise_on_error=False,
                log_command=f"diagnostics: {label}",
            )

    async def _cleanup_release_artifacts(self) -> None:
        await self.deployer.exec_command(
            "if [ -d /srv/frameos/build ] && cd /srv/frameos/build && ls -dt1 build_* >/dev/null 2>&1; then "
            "ls -dt1 build_* | tail -n +11 | xargs rm -rf; "
            "fi",
            raise_on_error=False,
        )
        await self.deployer.exec_command(
            "mkdir -p /srv/frameos/build/cache && cd /srv/frameos/build/cache && find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf"
        )
        await self.deployer.exec_command(
            "cd /srv/frameos/releases && "
            "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" | tail -n +11 | xargs rm -rf"
        )

    @staticmethod
    def _release_dir(build_id: str) -> str:
        return f"/srv/frameos/releases/release_{build_id}"

    @classmethod
    def _release_frameos_path(cls, build_id: str) -> str:
        return f"{cls._release_dir(build_id)}/frameos"

    @classmethod
    def _release_driver_dir(cls, build_id: str) -> str:
        return f"{cls._release_dir(build_id)}/drivers"

    @classmethod
    def _release_scene_dir(cls, build_id: str) -> str:
        return f"{cls._release_dir(build_id)}/scenes"

    @staticmethod
    def _remote_build_dir(build_id: str) -> str:
        return f"/srv/frameos/build/build_{build_id}"

    @staticmethod
    def _remote_build_archive_path(build_id: str) -> str:
        return f"/srv/frameos/build/build_{build_id}.tar.gz"

    async def _run_post_deploy_cleanup(self, *, post_deploy: dict[str, Any]) -> None:
        await self.deployer.log("stdout", f"{icon} Running final cleanup scripts")
        boot_config = str(post_deploy.get("boot_config_path") or "/boot/config.txt")

        if post_deploy.get("low_memory_masks_apt_daily"):
            await self.deployer.exec_command(
                "sudo systemctl mask apt-daily-upgrade && "
                "sudo systemctl mask apt-daily && "
                "sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service"
            )

        reboot_schedule = post_deploy.get("reboot_schedule") or {}
        if reboot_schedule.get("needs_update"):
            cron_schedule = reboot_schedule.get("crontab", "0 0 * * *")
            reboot_command = reboot_schedule.get("command", "systemctl restart frameos.service")
            crontab = f"{cron_schedule} root {reboot_command}"
            await self.deployer.exec_command(f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
        elif reboot_schedule.get("needs_remove"):
            await self.deployer.exec_command("sudo rm -f /etc/cron.d/frameos-reboot")

        for change in post_deploy.get("bootconfig_changes") or []:
            line = change.get("line")
            if not line:
                continue
            if change.get("action") == "remove":
                to_remove = str(line)
                await self.deployer.exec_command(
                    f'grep -q "^{to_remove}" {boot_config} && sudo sed -i "/^{to_remove}/d" {boot_config}',
                    raise_on_error=False,
                )
            elif change.get("action") == "add":
                if (await self.deployer.exec_command(f'grep -q "^{line}" {boot_config}', raise_on_error=False)) != 0:
                    await self.deployer.exec_command(f'echo "{line}" | sudo tee -a ' + boot_config, log_output=False)

        if post_deploy.get("disable_userconfig"):
            await self.deployer.exec_command("sudo systemctl disable userconfig || true")

        if post_deploy.get("disable_caddy_service"):
            await self.deployer.log("stdout", f"{icon} Disabling system-managed Caddy service (managed by FrameOS tls_proxy)")
            await self.deployer.exec_command("sudo systemctl disable --now caddy.service", raise_on_error=False)

        setup_json_reset_path = setup_json_reset_file_path(self.frame)
        if setup_json_reset_path:
            await self._install_setup_json_reset_helper(setup_json_reset_path)
        else:
            await self._remove_setup_json_reset_helper()

        if post_deploy.get("final_action") == "reboot":
            await self.deployer.log("stdinfo", f"{icon} Deployed! Rebooting device after boot config changes")
            await self.deployer.exec_command("sudo reboot")
        else:
            await self.deployer.exec_command("sudo systemctl daemon-reload")
            await self.deployer.log("stdinfo", f"{icon} Deployed! Restarting FrameOS")
            await self.deployer.exec_command("sudo systemctl restart frameos.service")
            await self.deployer.exec_command("sudo systemctl status frameos.service")

    async def _install_setup_json_reset_helper(self, setup_json_reset_path: str) -> None:
        await self.deployer.log("stdout", f"{icon} Installing setup JSON reset helper")
        script_path = f"/srv/frameos/build/{SETUP_JSON_RESET_SCRIPT_NAME}"
        service_path = f"/srv/frameos/build/{SETUP_JSON_RESET_SERVICE_NAME}"
        await upload_file(
            self.deployer.db,
            self.deployer.redis,
            self.deployer.frame,
            script_path,
            render_setup_json_reset_script(setup_json_reset_path).encode("utf-8"),
        )
        await upload_file(
            self.deployer.db,
            self.deployer.redis,
            self.deployer.frame,
            service_path,
            render_setup_json_reset_service(
                setup_json_reset_path,
                script_path=SETUP_JSON_RESET_SCRIPT_PATH,
            ).encode("utf-8"),
        )
        await self.deployer.exec_command(
            f"sudo install -m 755 {shlex.quote(script_path)} {shlex.quote(SETUP_JSON_RESET_SCRIPT_PATH)}"
        )
        await self.deployer.exec_command(
            f"sudo install -m 644 {shlex.quote(service_path)} {shlex.quote(SETUP_JSON_RESET_SERVICE_PATH)}"
        )
        await self.deployer.exec_command("sudo systemctl daemon-reload")
        await self.deployer.exec_command(f"sudo systemctl enable {SETUP_JSON_RESET_SERVICE_NAME}", raise_on_error=False)

    async def _remove_setup_json_reset_helper(self) -> None:
        await self.deployer.log("stdout", f"{icon} Removing setup JSON reset helper")
        await self.deployer.exec_command(f"sudo systemctl disable {SETUP_JSON_RESET_SERVICE_NAME}", raise_on_error=False)
        await self.deployer.exec_command(
            f"sudo rm -f {shlex.quote(SETUP_JSON_RESET_SERVICE_PATH)} {shlex.quote(SETUP_JSON_RESET_SCRIPT_PATH)}",
            raise_on_error=False,
        )
        await self.deployer.exec_command(
            f"rm -f /srv/frameos/build/{SETUP_JSON_RESET_SERVICE_NAME} /srv/frameos/build/{SETUP_JSON_RESET_SCRIPT_NAME}",
            raise_on_error=False,
        )

    async def _plan_post_deploy_cleanup(self, *, drivers: dict[str, Any], low_memory: bool) -> dict[str, Any]:
        boot_config = "/boot/config.txt"
        if await self.deployer.exec_command("test -f /boot/firmware/config.txt", raise_on_error=False) == 0:
            boot_config = "/boot/firmware/config.txt"

        i2c_needs_boot_config_line = False
        i2c_needs_runtime_enable = False
        if drivers.get("i2c"):
            i2c_needs_boot_config_line = not await self._command_succeeds(
                f'grep -q "^dtparam=i2c_vc=on$" {shlex.quote(boot_config)}'
            )
            i2c_needs_runtime_enable = await self._command_succeeds(
                'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1"'
            )

        spi_action = "unchanged"
        if drivers.get("spi") and await self._command_succeeds(
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_spi | grep -q "1"'
        ):
            spi_action = "enable"
        elif drivers.get("noSpi") and await self._command_succeeds(
            'command -v raspi-config > /dev/null && sudo raspi-config nonint get_spi | grep -q "0"'
        ):
            spi_action = "disable"

        low_memory_masks_apt_daily = False
        if low_memory and not _is_buildroot_frame(self.frame):
            apt_daily_masked = await self._command_succeeds("systemctl is-enabled apt-daily.service | grep -q masked")
            apt_daily_upgrade_masked = await self._command_succeeds(
                "systemctl is-enabled apt-daily-upgrade.service | grep -q masked"
            )
            low_memory_masks_apt_daily = not (apt_daily_masked and apt_daily_upgrade_masked)

        reboot_schedule: dict[str, Any] = {"enabled": False, "needs_update": False, "needs_remove": False}
        if self.frame.reboot and self.frame.reboot.get("enabled") == "true":
            cron_schedule = normalize_reboot_crontab(self.frame.reboot.get("crontab", "0 0 * * *"))
            reboot_type = self.frame.reboot.get("type")
            reboot_command = "/sbin/shutdown -r now" if reboot_type == "raspberry" else "systemctl restart frameos.service"
            desired_crontab = f"{cron_schedule} root {reboot_command}"
            reboot_schedule = {
                "enabled": True,
                "crontab": cron_schedule,
                "type": reboot_type,
                "command": reboot_command,
                "needs_update": not await self._command_succeeds(
                    f"test -f /etc/cron.d/frameos-reboot && grep -Fxq {shlex.quote(desired_crontab)} /etc/cron.d/frameos-reboot"
                ),
                "needs_remove": False,
            }
        else:
            reboot_schedule["needs_remove"] = await self._path_exists("/etc/cron.d/frameos-reboot")

        bootconfig_changes: list[dict[str, str]] = []
        for line in list((drivers.get("bootconfig").lines or [])) if drivers.get("bootconfig") else []:
            if line.startswith("#"):
                to_remove = line[1:]
                if await self._command_succeeds(f'grep -q "^{to_remove}" {shlex.quote(boot_config)}'):
                    bootconfig_changes.append({"action": "remove", "line": to_remove})
            elif not await self._command_succeeds(f'grep -q "^{line}" {shlex.quote(boot_config)}'):
                bootconfig_changes.append({"action": "add", "line": line})

        last_successful_deploy_at = getattr(self.frame, "last_successful_deploy_at", None)
        disable_userconfig = last_successful_deploy_at is None and await self._command_succeeds(
            "systemctl is-enabled userconfig >/dev/null 2>&1"
        )
        disable_caddy_service = await self._command_succeeds(
            "systemctl is-enabled caddy.service >/dev/null 2>&1 || systemctl is-active caddy.service >/dev/null 2>&1"
        )
        must_reboot = (
            bool(bootconfig_changes)
            or disable_userconfig
            or i2c_needs_boot_config_line
            or i2c_needs_runtime_enable
            or spi_action != "unchanged"
        )

        return {
            "boot_config_path": boot_config,
            "i2c": {
                "requested": bool(drivers.get("i2c")),
                "needs_boot_config_line": i2c_needs_boot_config_line,
                "needs_runtime_enable": i2c_needs_runtime_enable,
            },
            "spi_action": spi_action,
            "low_memory_masks_apt_daily": low_memory_masks_apt_daily,
            "reboot_schedule": reboot_schedule,
            "bootconfig_changes": bootconfig_changes,
            "disable_userconfig": disable_userconfig,
            "disable_caddy_service": disable_caddy_service,
            "final_action": "reboot" if must_reboot else "restart_frameos",
        }

    async def _plan_package(self, name: str, reason: str, run_after_install: str | None = None) -> PackagePlan:
        installed = await self._is_package_installed(name)
        return PackagePlan(name=name, reason=reason, installed=installed, run_after_install=run_after_install)

    async def _plan_package_alternatives(self, names: list[str], reason: str) -> PackageAlternativePlan:
        for name in names:
            if await self._is_package_installed(name):
                return PackageAlternativePlan(names=names, reason=reason, installed_package=name)
        return PackageAlternativePlan(names=names, reason=reason)

    async def _is_package_installed(self, name: str) -> bool:
        status = await self.deployer.exec_command(
            f"dpkg-query -W -f='${{Status}}' {shlex.quote(name)} 2>/dev/null | grep -q '^install ok installed$'",
            raise_on_error=False,
            log_command=False,
            log_output=False,
        )
        return status == 0

    async def _path_exists(self, path: str) -> bool:
        status = await self.deployer.exec_command(
            f"test -e {shlex.quote(path)}",
            raise_on_error=False,
            log_command=False,
            log_output=False,
        )
        return status == 0

    async def _command_succeeds(self, command: str) -> bool:
        status = await self.deployer.exec_command(
            command,
            raise_on_error=False,
            log_command=False,
            log_output=False,
        )
        return status == 0
