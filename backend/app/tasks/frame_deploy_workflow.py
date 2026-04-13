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
from app.models.assets import sync_assets
from app.models.frame import Frame, normalize_https_proxy, update_frame
from app.models.log import new_log as log
from app.models.settings import get_settings_dict
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.binary_builder import FrameBinaryBuilder, FrameBinaryPlan
from app.tasks.frame_deploy_helpers import (
    DEFAULT_QUICKJS_VERSION,
    ensure_lgpio,
    ensure_ntp_installed,
    ensure_quickjs,
    icon,
    install_if_necessary,
    sync_vendor_dir,
    upload_binary,
)
from app.utils.frame_http import _fetch_frame_http_bytes
from app.utils.remote_exec import upload_file
from app.utils.ssh_authorized_keys import _install_authorized_keys
from app.utils.ssh_key_utils import normalize_ssh_keys, select_ssh_keys_for_frame
from app.utils.versions import current_frameos_version

REMOTE_BUILD_APT_PACKAGES = (
    "build-essential",
    "hostapd",
    "imagemagick",
)


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

        notes = [
            f"Detected distro: {distro}",
            "Fast deploy only updates frame metadata and interpreted scene payloads.",
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

        if distro not in {"raspios", "debian", "ubuntu"}:
            raise Exception(f"Unsupported target distro '{distro}'")

        drivers = drivers_for_frame(self.frame)
        driver_names = sorted(drivers.keys())

        rpios_settings = self.frame.rpios or {}
        cross_compilation_setting = (rpios_settings.get("crossCompilation") or "auto").lower()
        if cross_compilation_setting not in {"auto", "always", "never"}:
            cross_compilation_setting = "auto"

        allow_cross_compile = cross_compilation_setting != "never"
        force_cross_compile = cross_compilation_setting == "always"
        binary_plan = await self.binary_builder.plan_build(
            allow_cross_compile=allow_cross_compile,
            force_cross_compile=force_cross_compile,
        )

        settings = get_settings_dict(self.db)
        selected_keys = select_ssh_keys_for_frame(self.frame, settings)
        selected_public_keys = [key.get("public") for key in selected_keys if key.get("public")]
        known_public_keys = [key.get("public") for key in normalize_ssh_keys(settings) if key.get("public")]
        previous_ssh_keys = self.frame.last_successful_deploy.get("ssh_keys") if isinstance(self.frame.last_successful_deploy, dict) else None
        ssh_keys_need_install = list(getattr(self.frame, "ssh_keys", None) or []) != list(previous_ssh_keys or [])

        package_plans: list[PackagePlan] = []
        package_alternatives = [
            await self._plan_package_alternatives(["ntp", "ntpsec"], "time synchronization"),
        ]

        for pkg_name in REMOTE_BUILD_APT_PACKAGES:
            package_plans.append(await self._plan_package(pkg_name, "base remote deploy/build dependency"))
        if not binary_plan.will_attempt_cross_compile:
            package_plans.append(await self._plan_package("libssl-dev", "OpenSSL headers for on-device FrameOS build"))
        package_plans.append(
            await self._plan_package(
                "caddy",
                "FrameOS TLS proxy support",
                run_after_install="sudo systemctl disable --now caddy.service",
            )
        )

        if drivers.get("evdev"):
            package_plans.append(await self._plan_package("libevdev-dev", "evdev driver support"))

        lgpio_required = bool(drivers.get("waveshare") or drivers.get("gpioButton"))
        lgpio_installed = False
        if lgpio_required:
            lgpio_installed = await self._path_exists("/usr/local/include/lgpio.h") or await self._path_exists("/usr/include/lgpio.h")
            if not lgpio_installed:
                package_plans.append(await self._plan_package("liblgpio-dev", "GPIO/Waveshare driver support"))

        for pkg_name in self.deployer.get_apt_packages():
            package_plans.append(await self._plan_package(pkg_name, "app-declared apt dependency"))

        if drivers.get("inkyPython"):
            package_plans.extend(
                [
                    await self._plan_package("python3-pip", "inkyPython vendor setup"),
                    await self._plan_package("python3-venv", "inkyPython vendor setup"),
                ]
            )
        if drivers.get("inkyHyperPixel2r"):
            package_plans.extend(
                [
                    await self._plan_package("python3-dev", "inkyHyperPixel2r vendor setup"),
                    await self._plan_package("python3-pip", "inkyHyperPixel2r vendor setup"),
                    await self._plan_package("python3-venv", "inkyHyperPixel2r vendor setup"),
                ]
            )

        quickjs_required_if_remote_build = not force_cross_compile
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
            if not quickjs_installed:
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
        ]
        if low_memory:
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
            await self.deployer._upload_frame_json("/srv/frameos/current/frame.json")
            await self.deployer._upload_scenes_json("/srv/frameos/current/scenes.json.gz", gzip=True)

            if not plan.fast_deploy:
                raise RuntimeError("Fast deploy plan missing")

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
            raise Exception("Already deploying. Request again to force redeploy.")
        if not plan.full_deploy:
            raise RuntimeError("Full deploy plan missing")

        full_plan = plan.full_deploy
        frame = self.frame
        frame.status = "deploying"
        await update_frame(self.db, self.redis, frame)

        install_package = partial(install_if_necessary, self.deployer)
        build_id = plan.build_id

        await self.deployer.log("stdout", f"{icon} Deploying frame {frame.name} with build id {build_id}")

        try:
            if full_plan.selected_public_keys and full_plan.ssh_keys_need_install:
                await self.deployer.log("stdout", f"{icon} Checking SSH keys on device")
                await _install_authorized_keys(
                    self.db,
                    self.redis,
                    frame,
                    full_plan.selected_public_keys,
                    full_plan.known_public_keys,
                )
            elif not full_plan.selected_public_keys:
                await self.deployer.log("stdout", f"{icon} No SSH public keys configured; skipping authorized_keys install")
            else:
                await self.deployer.log("stdout", f"{icon} SSH public keys already match the last deploy; skipping authorized_keys install")

            build_result = await self.binary_builder.build(full_plan.binary_plan)
            prebuilt_entry = build_result.prebuilt_entry
            cross_compiled = build_result.cross_compiled

            if full_plan.low_memory and not cross_compiled:
                await self.deployer.log("stdout", f"{icon} Low memory device, stopping FrameOS for compilation")
                await self.deployer.exec_command("sudo service frameos stop", raise_on_error=False)

            if not cross_compiled and full_plan.binary_plan.will_attempt_cross_compile:
                await install_package("libssl-dev")

            await self.deployer.log("stdout", f"{icon} Installing dependencies on remote")
            for alternative in full_plan.package_alternatives:
                if alternative.names == ["ntp", "ntpsec"] and not alternative.installed_package:
                    await ensure_ntp_installed(self.deployer)

            for package_plan in full_plan.package_plans:
                if package_plan.installed:
                    continue
                await install_package(
                    package_plan.name,
                    run_after_install=package_plan.run_after_install,
                )

            await ensure_lgpio(
                self.deployer,
                drivers=drivers_for_frame(frame),
                prebuilt_entry=prebuilt_entry,
                already_installed=full_plan.lgpio_installed,
            )

            quickjs_dirname = await ensure_quickjs(
                self.deployer,
                prebuilt_entry=prebuilt_entry,
                build_id=build_id,
                cross_compiled=cross_compiled,
                quickjs_installed=full_plan.quickjs_installed,
                quickjs_dirname=full_plan.quickjs_dirname or f"quickjs-{DEFAULT_QUICKJS_VERSION}",
            )

            await self.deployer.exec_command("sudo mkdir -p /srv/frameos && sudo chown $(whoami):$(whoami) /srv/frameos")
            await self.deployer.exec_command("mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
            await self.deployer.exec_command(f"mkdir -p /srv/frameos/releases/release_{build_id}")
            release_frameos_path = f"/srv/frameos/releases/release_{build_id}/frameos"

            if cross_compiled:
                await self.deployer.log("stdout", f"{icon} Using cross-compiled binary")
                if not build_result.binary_path:
                    raise RuntimeError("Cross compilation succeeded but binary path is unknown")
                await upload_binary(self.deployer, build_result.binary_path, release_frameos_path)
            else:
                await self.deployer.log("stdout", f"{icon} Building FrameOS on remote, no cross-compilation")
                await self.deployer.log("stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")

                with open(build_result.archive_path, "rb") as fh:
                    data = fh.read()
                await upload_file(
                    self.deployer.db,
                    self.deployer.redis,
                    self.deployer.frame,
                    f"/srv/frameos/build/build_{build_id}.tar.gz",
                    data,
                )

                await self.deployer.exec_command(
                    f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz"
                )
                if quickjs_dirname:
                    await self.deployer.exec_command(
                        f"ln -s /srv/frameos/vendor/quickjs/{quickjs_dirname} /srv/frameos/build/build_{build_id}/quickjs",
                    )
                await self.deployer.exec_command(
                    f"cd /srv/frameos/build/build_{build_id} && "
                    "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
                    "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
                    "make -j$PARALLEL",
                    timeout=3600,
                )
                await self.deployer.exec_command(
                    f"cp /srv/frameos/build/build_{build_id}/frameos {release_frameos_path}"
                )

            await self.deployer._upload_scenes_json(f"/srv/frameos/releases/release_{build_id}/scenes.json.gz", gzip=True)
            await self.deployer._upload_frame_json(f"/srv/frameos/releases/release_{build_id}/frame.json")

            drivers = drivers_for_frame(frame)
            if inky_python := drivers.get("inkyPython"):
                vendor_folder = inky_python.vendor_folder or ""
                await sync_vendor_dir(
                    self.deployer,
                    os.path.join(build_result.build_dir, "vendor", vendor_folder),
                    vendor_folder,
                    "inkyPython vendor files",
                    cross_compiled,
                    build_id,
                )
                await self.deployer.exec_command(
                    f"cd /srv/frameos/vendor/{inky_python.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            if inky_hyperpixel := drivers.get("inkyHyperPixel2r"):
                vendor_folder = inky_hyperpixel.vendor_folder or ""
                await sync_vendor_dir(
                    self.deployer,
                    os.path.join(build_result.build_dir, "vendor", vendor_folder),
                    vendor_folder,
                    "inkyHyperPixel2r vendor files",
                    cross_compiled,
                    build_id,
                )
                await self.deployer.exec_command(
                    f"cd /srv/frameos/vendor/{inky_hyperpixel.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            with open("../frameos/frameos.service", "r", encoding="utf-8") as f:
                service_contents = f.read().replace("%I", frame.ssh_user)
            await upload_file(
                self.deployer.db,
                self.deployer.redis,
                self.deployer.frame,
                f"/srv/frameos/releases/release_{build_id}/frameos.service",
                service_contents.encode("utf-8"),
            )

            await self.deployer.exec_command(
                f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state /srv/frameos/releases/release_{build_id}/state"
            )
            await self.deployer.exec_command(
                f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service /etc/systemd/system/frameos.service"
            )
            await self.deployer.exec_command("sudo chown root:root /etc/systemd/system/frameos.service")
            await self.deployer.exec_command("sudo chmod 644 /etc/systemd/system/frameos.service")
            await self.deployer.exec_command(
                f"rm -rf /srv/frameos/current && ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current"
            )

            await sync_assets(self.db, self.redis, frame)
            await self.deployer.exec_command("cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
            await self.deployer.exec_command("mkdir -p /srv/frameos/build/cache && cd /srv/frameos/build/cache && find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf")
            await self.deployer.exec_command(
                "cd /srv/frameos/releases && "
                "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" | tail -n +11 | xargs rm -rf"
            )

            await self._run_post_deploy_cleanup(post_deploy=full_plan.post_deploy)

            frame.status = "starting"
            plan.frame_dict["frameos_version"] = current_frameos_version()
            frame.last_successful_deploy = plan.frame_dict
            frame.last_successful_deploy_at = datetime.now(timezone.utc)
            await update_frame(self.db, self.redis, frame)
        except Exception:
            frame.status = "uninitialized"
            await update_frame(self.db, self.redis, frame)
            raise

    async def _run_post_deploy_cleanup(self, *, post_deploy: dict[str, Any]) -> None:
        await self.deployer.log("stdout", f"{icon} Running final cleanup scripts")
        boot_config = str(post_deploy.get("boot_config_path") or "/boot/config.txt")

        i2c_plan = post_deploy.get("i2c") or {}
        if i2c_plan.get("needs_boot_config_line"):
            await self.deployer.exec_command(
                'grep -q "^dtparam=i2c_vc=on$" ' + boot_config + ' || echo "dtparam=i2c_vc=on" | sudo tee -a ' + boot_config
            )
        if i2c_plan.get("needs_runtime_enable"):
            await self.deployer.exec_command(
                'command -v raspi-config > /dev/null && '
                'sudo raspi-config nonint get_i2c | grep -q "1" && { sudo raspi-config nonint do_i2c 0; echo "I2C enabled"; } || echo "I2C already enabled"'
            )

        spi_action = post_deploy.get("spi_action")
        if spi_action == "enable":
            await self.deployer.exec_command("sudo raspi-config nonint do_spi 0")
        elif spi_action == "disable":
            await self.deployer.exec_command("sudo raspi-config nonint do_spi 1")

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

        if post_deploy.get("final_action") == "reboot":
            await self.deployer.exec_command("sudo systemctl enable frameos.service")
            await self.deployer.log("stdinfo", f"{icon} Deployed! Rebooting device after boot config changes")
            await self.deployer.exec_command("sudo reboot")
        else:
            await self.deployer.exec_command("sudo systemctl daemon-reload")
            await self.deployer.log("stdinfo", f"{icon} Deployed! Restarting FrameOS")
            await self.deployer.restart_service("frameos")

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
        if low_memory:
            apt_daily_masked = await self._command_succeeds("systemctl is-enabled apt-daily.service | grep -q masked")
            apt_daily_upgrade_masked = await self._command_succeeds(
                "systemctl is-enabled apt-daily-upgrade.service | grep -q masked"
            )
            low_memory_masks_apt_daily = not (apt_daily_masked and apt_daily_upgrade_masked)

        reboot_schedule: dict[str, Any] = {"enabled": False, "needs_update": False, "needs_remove": False}
        if self.frame.reboot and self.frame.reboot.get("enabled") == "true":
            cron_schedule = self.frame.reboot.get("crontab", "0 0 * * *")
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
        must_reboot = bool(bootconfig_changes) or disable_userconfig

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
