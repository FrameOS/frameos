from datetime import datetime, timezone
import os
import re
import shlex
import shutil
import tempfile
from typing import Any


from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.drivers.devices import drivers_for_frame
from app.models.assets import copy_custom_fonts_to_local_source_folder, sync_assets
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.remote_exec import upload_file
from app.utils.local_exec import exec_local_command
from app.models.settings import get_settings_dict
from app.utils.nix_utils import nix_cmd
from app.utils.cross_compile import (
    build_binary_with_cross_toolchain,
    can_cross_compile_target,
)
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.prebuilt_deps import fetch_prebuilt_manifest, resolve_prebuilt_target

from .utils import find_nim_v2

DEFAULT_QUICKJS_VERSION = "2025-04-26"
DEFAULT_QUICKJS_SHA256 = "2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf"
DEFAULT_LGPIO_VERSION = "v0.2.2"
DEFAULT_LGPIO_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
LGPIO_ARCHIVE_URL = "https://github.com/joan2937/lg/archive/refs/tags/{version}.tar.gz"


APT_PACKAGE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+.-]*$")


def _sanitize_apt_package_name(pkg: str) -> str:
    """Validate *pkg* to prevent shell injection in apt installs."""

    normalized = pkg.strip()
    if not normalized:
        raise ValueError("Invalid apt package name: empty value")
    if not APT_PACKAGE_NAME_PATTERN.fullmatch(normalized):
        raise ValueError(f"Invalid apt package name: {pkg!r}")
    return normalized

async def deploy_frame(id: int, redis: Redis):
    await redis.enqueue_job("deploy_frame", id=id)

async def deploy_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    frame = db.get(Frame, id)
    if not frame:
        raise Exception("Frame not found")

    try:
        if not frame.scenes or len(frame.scenes) == 0:
            raise Exception("You must have at least one installed scene to deploy. Make sure to press the \"Save\" button as well.")

        if frame.status == 'deploying':
            raise Exception("Already deploying. Request again to force redeploy.")

        frame_dict = frame.to_dict() # persisted as frame.last_successful_deploy if successful
        if "last_successful_deploy" in frame_dict:
            del frame_dict["last_successful_deploy"]
        if "last_successful_deploy_at" in frame_dict:
            del frame_dict["last_successful_deploy_at"]

        frame.status = 'deploying'
        await update_frame(db, redis, frame)

        nim_path = find_nim_v2()
        settings = get_settings_dict(db)

        async def install_if_necessary(pkg: str, raise_on_error=True) -> int:
            try:
                sanitized_pkg = _sanitize_apt_package_name(pkg)
            except ValueError as exc:
                await self.log("stderr", f"- {exc}")
                if raise_on_error:
                    raise
                return 1

            search_strings = ["run apt-get update", "404 Not Found", "Failed to fetch", "failed to fetch", "Unable to fetch some archives"]
            output: list[str] = []
            quoted_pkg = shlex.quote(sanitized_pkg)
            response = await self.exec_command(
                f"dpkg -l | grep -q \"^ii  {quoted_pkg} \" || sudo apt-get install -y {quoted_pkg}",
                raise_on_error=False,
                output=output
            )
            if response != 0:
                combined_output = "".join(output)
                if any(s in combined_output for s in search_strings):
                    await self.log("stdout", f"- Installing {sanitized_pkg} failed. Trying to update apt.")
                    response = await self.exec_command(
                        "sudo apt-get update && sudo apt-get install -y " + quoted_pkg,
                        raise_on_error=raise_on_error
                    )
                    if response != 0: # we propably raised above
                        await self.log("stdout", f"- Installing {sanitized_pkg} failed again.")
            return response

        with tempfile.TemporaryDirectory() as temp_dir:
            self = FrameDeployer(db=db, redis=redis, frame=frame, nim_path=nim_path, temp_dir=temp_dir)
            build_id = self.build_id
            await self.log("stdout", f"Deploying frame {frame.name} with build id {self.build_id}")

            arch = await self.get_cpu_architecture()
            distro = await self.get_distro()
            distro_version = await self.get_distro_version()
            total_memory = await self.get_total_memory_mb()
            low_memory = total_memory < 512

            await self.log(
                "stdout",
                f"- Detected distro: {distro} ({distro_version}), architecture: {arch}, total memory: {total_memory} MiB",
            )

            prebuilt_entry = None
            prebuilt_target = resolve_prebuilt_target(distro, distro_version, arch)
            if prebuilt_target:
                try:
                    manifest = await fetch_prebuilt_manifest()
                except Exception as exc:
                    await self.log(
                        "stdout",
                        f"- Could not load prebuilt manifest for target {prebuilt_target}: {exc}",
                    )
                else:
                    prebuilt_entry = manifest.get(prebuilt_target)
                    if prebuilt_entry:
                        await self.log("stdout", f"- Using prebuilt target '{prebuilt_target}' when available")
                    else:
                        await self.log("stdout", f"- No prebuilt components published for '{prebuilt_target}'")
            elif distro in ("raspios", "debian"):
                await self.log(
                    "stdout",
                    "- No matching prebuilt target for this distro/version/arch combination",
                )

            # Fast-path for NixOS targets
            if distro == "nixos":
                await self.log("stdout", "- NixOS detected – using flake-based deploy")
                await self.log("stdout", f"- Preparing sources with local modifications under {temp_dir}")
                source_dir_local = self.create_local_source_folder(temp_dir)
                await self.make_local_modifications(source_dir_local)
                await copy_custom_fonts_to_local_source_folder(db, source_dir_local)

                sys_build_cmd, masked_build_cmd, cleanup = nix_cmd(
                    "nix --extra-experimental-features 'nix-command flakes' "
                    f"build \"$(realpath {source_dir_local})\"#nixosConfigurations.\"frame-host\".config.system.build.toplevel "
                    "--system aarch64-linux --print-out-paths "
                    "--log-format raw -L",
                    settings
                )
                try:
                    await self.log("stdout", f"$ {masked_build_cmd}")
                    status, sys_out, sys_err = await exec_local_command(self.db, self.redis, self.frame, sys_build_cmd, log_command=False)
                finally:
                    cleanup()
                if status != 0 or not sys_out:
                    raise Exception(f"Local NixOS system build failed:\n{sys_err}")
                result_path = sys_out.strip().splitlines()[-1]

                updated_count = await self.nix_upload_path_and_deps(result_path)

                await self._upload_scenes_json("/var/lib/frameos/scenes.json.gz", gzip=True)
                await self._upload_frame_json("/var/lib/frameos/frame.json")
                await sync_assets(db, redis, frame)

                if updated_count == 0:
                    await self.restart_service("frameos")
                else:
                    await self.exec_command(f"sudo nix-env --profile /nix/var/nix/profiles/system --set {result_path}")
                    await self.exec_command(
                        "sudo systemd-run --unit=nixos-switch --no-ask-password "
                        "/nix/var/nix/profiles/system/bin/switch-to-configuration switch"
                    )
                #  Save deploy metadata & finish early – nothing else to do
                frame.status = 'starting'
                frame.last_successful_deploy     = frame_dict
                frame.last_successful_deploy_at  = datetime.now(timezone.utc)
                await update_frame(db, redis, frame)
                await self.log("stdinfo", f"Deploy finished in {datetime.now() - self.deploy_start} 🎉")
                return   # ← all done, skip the legacy RPiOS flow

            ## /END NIXOS


            ## Deploy onto Raspberry Pi OS or Debian/Ubuntu:

            if distro == "raspios":
                await self.log("stdout", "- Raspberry Pi OS detected")
            elif distro in ("debian", "ubuntu"):
                await self.log("stdout", "- Debian/Ubuntu detected")
            else:
                await self.log("stdout", f"- Unknown distro '{distro}', trying apt and hoping for the best")
                distro = "debian"

            drivers = drivers_for_frame(frame)

            # 1. Create build tar.gz locally
            await self.log("stdout", "- Copying build folders")
            build_dir = create_build_folder(temp_dir, build_id)
            source_dir = self.create_local_source_folder(temp_dir)
            await self.log("stdout", "- Applying local modifications")
            await self.make_local_modifications(source_dir)
            await self.log("stdout", "- Creating build archive")
            archive_path = await self.create_local_build_archive(build_dir, source_dir, arch)

            cross_compiled = False
            if can_cross_compile_target(arch):
                await self.log("stdout", "- Target supports cross compilation; building binary locally")
                try:
                    await build_binary_with_cross_toolchain(
                        db=db,
                        redis=redis,
                        frame=frame,
                        deployer=self,
                        source_dir=source_dir,
                        temp_dir=temp_dir,
                    )
                except Exception as exc:
                    await self.log(
                        "stderr",
                        f"- Cross compilation failed ({exc}); falling back to on-device build",
                    )
                else:
                    cross_compiled = True
                    archive_path = shutil.make_archive(
                        build_dir,
                        "gztar",
                        temp_dir,
                        os.path.basename(build_dir),
                    )
                    await self.log("stdout", "- Cross compilation succeeded; skipping remote build")

            if low_memory and not cross_compiled:
                await self.log("stdout", "- Low memory device, stopping FrameOS for compilation")
                await self.exec_command("sudo service frameos stop", raise_on_error=False)

            # 2. Remote steps
            async def ensure_ntp_installed() -> None:
                """Ensure either the legacy ntp package or ntpsec is present."""

                async def package_is_installed(pkg: str) -> bool:
                    quoted_pkg = shlex.quote(pkg)
                    return (
                        await self.exec_command(
                            f"dpkg -l | grep -q \"^ii  {quoted_pkg} \"",
                            raise_on_error=False,
                        )
                        == 0
                    )

                if await package_is_installed("ntp") or await package_is_installed("ntpsec"):
                    return

                for candidate in ("ntp", "ntpsec"):
                    response = await install_if_necessary(candidate, raise_on_error=False)
                    if response == 0:
                        return

                raise Exception("Unable to install ntp or ntpsec via apt")

            await ensure_ntp_installed()
            await install_if_necessary("build-essential")
            await install_if_necessary("hostapd")
            await install_if_necessary("imagemagick")

            if drivers.get("evdev"):
                await install_if_necessary("libevdev-dev")

            if drivers.get("waveshare") or drivers.get("gpioButton"):
                check_lgpio = await self.exec_command(
                    'if [ -f "/usr/local/include/lgpio.h" ] || [ -f "/usr/include/lgpio.h" ]; then exit 0; else exit 1; fi',
                    raise_on_error=False
                )
                if check_lgpio != 0:
                    # Try installing liblgpio-dev
                    if await install_if_necessary("liblgpio-dev", raise_on_error=False) != 0:
                        await self.log("stdout", "--> Could not find liblgpio-dev. Trying archived builds.")
                        lgpio_installed = False
                        if prebuilt_entry:
                            lgpio_prebuilt_url = prebuilt_entry.url_for("lgpio")
                            lgpio_version = prebuilt_entry.version_for("lgpio", DEFAULT_LGPIO_VERSION)
                            lgpio_md5sum = prebuilt_entry.md5_for("lgpio")
                        else:
                            lgpio_prebuilt_url = None
                            lgpio_version = DEFAULT_LGPIO_VERSION
                            lgpio_md5sum = None

                        if lgpio_prebuilt_url:
                            try:
                                await self.log(
                                    "stdout",
                                    f"--> Installing lgpio {lgpio_version} from archive",
                                )
                                lgpio_command = (
                                    "rm -rf /tmp/lgpio-prebuilt && "
                                    "mkdir -p /tmp/lgpio-prebuilt && "
                                    f"wget -q -O /tmp/lgpio-prebuilt/lgpio.tar.gz {shlex.quote(lgpio_prebuilt_url)} && "
                                )
                                if lgpio_md5sum:
                                    lgpio_command += (
                                        f"echo '{lgpio_md5sum}  /tmp/lgpio-prebuilt/lgpio.tar.gz' | md5sum -c - && "
                                    )
                                lgpio_command += (
                                    "tar -xzf /tmp/lgpio-prebuilt/lgpio.tar.gz -C /tmp/lgpio-prebuilt && "
                                    "sudo mkdir -p /usr/local/include /usr/local/lib && "
                                    "sudo cp -r /tmp/lgpio-prebuilt/include/. /usr/local/include/ && "
                                    "sudo cp -r /tmp/lgpio-prebuilt/lib/. /usr/local/lib/ && "
                                    "sudo ldconfig && "
                                    "rm -rf /tmp/lgpio-prebuilt"
                                )
                                await self.exec_command(lgpio_command)
                                lgpio_installed = True
                            except Exception as exc:
                                await self.log(
                                    "stdout",
                                    f"--> Failed to install prebuilt lgpio ({exc}). Falling back to source build.",
                                )

                        if not lgpio_installed:
                            await self.log("stdout", "--> Installing lgpio from source.")
                            await install_if_necessary("python3-setuptools")
                            lgpio_tar = f"{DEFAULT_LGPIO_VERSION}.tar.gz"
                            lgpio_source_dir = f"lg-{DEFAULT_LGPIO_VERSION.lstrip('v')}"
                            command = (
                                "if [ ! -f /usr/local/include/lgpio.h ]; then "
                                "  rm -rf /tmp/lgpio-install && "
                                "  mkdir -p /tmp/lgpio-install && "
                                "  cd /tmp/lgpio-install && "
                                f"  wget -q -O {lgpio_tar} {LGPIO_ARCHIVE_URL.format(version=DEFAULT_LGPIO_VERSION)} && "
                                f"  echo '{DEFAULT_LGPIO_SHA256}  {lgpio_tar}' | sha256sum -c - && "
                                f"  tar -xzf {lgpio_tar} && "
                                f"  cd {lgpio_source_dir} && "
                                "  make && "
                                "  sudo make install && "
                                "  sudo rm -rf /tmp/lgpio-install; "
                                "fi"
                            )
                            await self.exec_command(command)

            # Any app dependencies
            for dep in self.get_apt_packages():
                await install_if_necessary(dep)

            quickjs_dirname: str | None = None
            if not cross_compiled:
                quickjs_version = (
                    prebuilt_entry.version_for("quickjs", DEFAULT_QUICKJS_VERSION)
                    if prebuilt_entry
                    else DEFAULT_QUICKJS_VERSION
                )
                quickjs_dirname = f"quickjs-{quickjs_version}"
                quickjs_vendor_dir = f"/srv/frameos/vendor/quickjs/{quickjs_dirname}"
                quickjs_prebuilt_url = prebuilt_entry.url_for("quickjs") if prebuilt_entry else None
                quickjs_md5sum = prebuilt_entry.md5_for("quickjs") if prebuilt_entry else None

                # Ensure /srv/frameos
                await self.exec_command(
                    "if [ ! -d /srv/frameos/ ]; then "
                    "  sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; "
                    "fi"
                )

                def _quickjs_exists_command(path: str) -> str:
                    return f'[[ -d "{path}" ]] && exit 0 || exit 1'

                quickjs_installed = (
                    await self.exec_command(
                        _quickjs_exists_command(quickjs_vendor_dir),
                        raise_on_error=False,
                    )
                    == 0
                )

                if not quickjs_installed and quickjs_prebuilt_url:
                    await self.log("stdout", f"- Downloading QuickJS prebuilt archive ({quickjs_dirname})")
                    quickjs_archive = f"/tmp/quickjs-prebuilt-{build_id}.tar.gz"
                    try:
                        quickjs_command = (
                            "mkdir -p /srv/frameos/vendor/quickjs/ && "
                            f"wget -q -O {quickjs_archive} {shlex.quote(quickjs_prebuilt_url)} && "
                        )
                        if quickjs_md5sum:
                            quickjs_command += f"echo '{quickjs_md5sum}  {quickjs_archive}' | md5sum -c - && "
                        quickjs_command += (
                            f"tar -xzf {quickjs_archive} -C /srv/frameos/vendor/quickjs/ && "
                            f"rm {quickjs_archive}"
                        )
                        await self.exec_command(quickjs_command)
                        await self.exec_command(
                            "bash -c '"
                            f"QUICKJS_DIR={shlex.quote(quickjs_vendor_dir)}; "
                            "if [ -d \"$QUICKJS_DIR/include/quickjs\" ]; then "
                            "  if [ -f \"$QUICKJS_DIR/include/quickjs/quickjs.h\" ] && [ ! -f \"$QUICKJS_DIR/quickjs.h\" ]; then "
                            "    cp \"$QUICKJS_DIR/include/quickjs/quickjs.h\" \"$QUICKJS_DIR/quickjs.h\"; "
                            "  fi; "
                            "  if [ -f \"$QUICKJS_DIR/include/quickjs/quickjs-libc.h\" ] && [ ! -f \"$QUICKJS_DIR/quickjs-libc.h\" ]; then "
                            "    cp \"$QUICKJS_DIR/include/quickjs/quickjs-libc.h\" \"$QUICKJS_DIR/quickjs-libc.h\"; "
                            "  fi; "
                            "fi; "
                            "if [ -f \"$QUICKJS_DIR/lib/libquickjs.a\" ] && [ ! -f \"$QUICKJS_DIR/libquickjs.a\" ]; then "
                            "  cp \"$QUICKJS_DIR/lib/libquickjs.a\" \"$QUICKJS_DIR/libquickjs.a\"; "
                            "fi'"
                        )
                        quickjs_installed = True
                    except Exception as exc:
                        await self.log(
                            "stdout",
                            f"- Failed to download prebuilt QuickJS ({exc}). Falling back to source build.",
                        )
                        quickjs_prebuilt_url = None
                        quickjs_version = DEFAULT_QUICKJS_VERSION
                        quickjs_dirname = f"quickjs-{quickjs_version}"
                        quickjs_vendor_dir = f"/srv/frameos/vendor/quickjs/{quickjs_dirname}"
                        quickjs_installed = (
                            await self.exec_command(
                                _quickjs_exists_command(quickjs_vendor_dir),
                                raise_on_error=False,
                            )
                            == 0
                        )

                if not quickjs_installed and quickjs_version != DEFAULT_QUICKJS_VERSION:
                    quickjs_version = DEFAULT_QUICKJS_VERSION
                    quickjs_dirname = f"quickjs-{quickjs_version}"
                    quickjs_vendor_dir = f"/srv/frameos/vendor/quickjs/{quickjs_dirname}"
                    quickjs_installed = (
                        await self.exec_command(
                            _quickjs_exists_command(quickjs_vendor_dir),
                            raise_on_error=False,
                        )
                        == 0
                    )

                if not quickjs_installed:
                    quickjs_tar = f"quickjs-{quickjs_version}.tar.xz"
                    await self.log("stdout", "- Downloading quickjs")
                    await self.exec_command(
                        "mkdir -p /srv/frameos/vendor/quickjs/ && "
                        f"wget -q -O {quickjs_tar} https://bellard.org/quickjs/{quickjs_tar} && "
                        f"echo '{DEFAULT_QUICKJS_SHA256}  {quickjs_tar}' | sha256sum -c - && "
                        f"tar -xJf {quickjs_tar} -C /srv/frameos/vendor/quickjs/ && "
                        f"rm {quickjs_tar}"
                    )
                    await self.log("stdout", "- Finished downloading quickjs")

                quickjs_has_makefile = (
                    await self.exec_command(
                        f'test -f "{quickjs_vendor_dir}/Makefile"',
                        raise_on_error=False,
                        log_command=False,
                        log_output=False,
                    )
                    == 0
                )
                if quickjs_has_makefile:
                    await self.exec_command(
                        f'cd {quickjs_vendor_dir} && make libquickjs.a'
                    )

            await self.exec_command("mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
            await self.log("stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")

            # 3. Upload the local tarball
            with open(archive_path, "rb") as fh:
                data = fh.read()
            await upload_file(
                self.db,
                self.redis,
                self.frame,
                f"/srv/frameos/build/build_{build_id}.tar.gz",
                data,
            )

            # Unpack & compile on device
            await self.exec_command(f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz")
            if not cross_compiled and quickjs_dirname:
                await self.exec_command(
                    f"ln -s /srv/frameos/vendor/quickjs/{quickjs_dirname} /srv/frameos/build/build_{build_id}/quickjs",
                )
                await self.exec_command(
                    f"cd /srv/frameos/build/build_{build_id} && "
                    "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
                    "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
                    "make -j$PARALLEL",
                    timeout=3600, # 30 minute timeout for compilation
                )
            elif cross_compiled:
                await self.log("stdout", "- Skipping on-device build; using cross-compiled binary")

            await self.exec_command(f"mkdir -p /srv/frameos/releases/release_{build_id}")
            await self.exec_command(
                f"cp /srv/frameos/build/build_{build_id}/frameos "
                f"/srv/frameos/releases/release_{build_id}/frameos"
            )

            # 4. Upload scenes.json.gz and frame.json
            await self._upload_scenes_json(f"/srv/frameos/releases/release_{build_id}/scenes.json.gz", gzip=True)
            await self._upload_frame_json(f"/srv/frameos/releases/release_{build_id}/frame.json")

            # Driver-specific vendor steps
            if inkyPython := drivers.get("inkyPython"):
                await self.exec_command(
                    f"mkdir -p /srv/frameos/vendor && "
                    f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyPython /srv/frameos/vendor/"
                )
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await self.exec_command(
                    f"cd /srv/frameos/vendor/{inkyPython.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
                await self.exec_command(
                    f"mkdir -p /srv/frameos/vendor && "
                    f"cp -r /srv/frameos/build/build_{build_id}/vendor/inkyHyperPixel2r /srv/frameos/vendor/"
                )
                await install_if_necessary("python3-dev")
                await install_if_necessary("python3-pip")
                await install_if_necessary("python3-venv")
                await self.exec_command(
                    f"cd /srv/frameos/vendor/{inkyHyperPixel2r.vendor_folder} && "
                    "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
                    "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
                    "(echo '> env/bin/pip3 install -r requirements.txt' && "
                    "env/bin/pip3 install -r requirements.txt && "
                    "sha256sum requirements.txt > requirements.txt.sha256sum))"
                )

            # 5. Upload frameos.service
            with open("../frameos/frameos.service", "r") as f:
                service_contents = f.read().replace("%I", frame.ssh_user)
            await upload_file(
                self.db, self.redis, self.frame,
                f"/srv/frameos/releases/release_{build_id}/frameos.service",
                service_contents.encode("utf-8"),
            )

            await self.exec_command(
                f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state "
                f"/srv/frameos/releases/release_{build_id}/state"
            )
            await self.exec_command(
                f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service "
                f"/etc/systemd/system/frameos.service"
            )
            await self.exec_command("sudo chown root:root /etc/systemd/system/frameos.service")
            await self.exec_command("sudo chmod 644 /etc/systemd/system/frameos.service")

            # 6. Link new release
            await self.exec_command(
                f"rm -rf /srv/frameos/current && "
                f"ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current"
            )

            # Figure out the difference between /srv/assets and the local assets folder
            await sync_assets(db, redis, frame)

            # Clean old builds
            await self.exec_command("cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
            await self.exec_command("cd /srv/frameos/build/cache && find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf")
            await self.exec_command(
                "cd /srv/frameos/releases && "
                "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" "
                "| tail -n +11 | xargs rm -rf"
            )

        boot_config = "/boot/config.txt"
        if await self.exec_command("test -f /boot/firmware/config.txt", raise_on_error=False) == 0:
            boot_config = "/boot/firmware/config.txt"

        # Additional device config
        if drivers.get("i2c"):
            await self.exec_command(
                'grep -q "^dtparam=i2c_vc=on$" ' + boot_config + ' '
                '|| echo "dtparam=i2c_vc=on" | sudo tee -a ' + boot_config
            )
            await self.exec_command(
                'command -v raspi-config > /dev/null && '
                'sudo raspi-config nonint get_i2c | grep -q "1" && { '
                '  sudo raspi-config nonint do_i2c 0; echo "I2C enabled"; '
                '} || echo "I2C already enabled"'
            )

        if drivers.get("spi"):
            await self.exec_command('sudo raspi-config nonint do_spi 0')
        elif drivers.get("noSpi"):
            await self.exec_command('sudo raspi-config nonint do_spi 1')

        if low_memory:
            await self.exec_command(
                "sudo systemctl mask apt-daily-upgrade && "
                "sudo systemctl mask apt-daily && "
                "sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service"
            )

        if frame.reboot and frame.reboot.get('enabled') == 'true':
            cron_schedule = frame.reboot.get('crontab', '0 0 * * *')
            if frame.reboot.get('type') == 'raspberry':
                crontab = f"{cron_schedule} root /sbin/shutdown -r now"
            else:
                crontab = f"{cron_schedule} root systemctl restart frameos.service"
            await self.exec_command(                               f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
        else:
            await self.exec_command("sudo rm -f /etc/cron.d/frameos-reboot")

        must_reboot = False

        if drivers.get("bootconfig"):
            for line in (drivers["bootconfig"].lines or []):
                if line.startswith("#"):
                    to_remove = line[1:]
                    await self.exec_command(f'grep -q "^{to_remove}" {boot_config} && sudo sed -i "/^{to_remove}/d" {boot_config}', raise_on_error=False)
                else:
                    if (await self.exec_command(f'grep -q "^{line}" ' + boot_config, raise_on_error=False)) != 0:
                        await self.exec_command(command=f'echo "{line}" | sudo tee -a ' + boot_config, log_output=False)
                        must_reboot = True

        if frame.last_successful_deploy_at is None:
            # Reboot after the first deploy to make sure any modifications to config.txt are persisted to disk
            # Otherwise if you pull out the power, you'll end up with a blank config.txt on the next boot.
            must_reboot = True

            # On first deploy disable the enter "new username" prompt
            await self.exec_command("sudo systemctl disable userconfig || true")

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)

        if must_reboot:
            await update_frame(db, redis, frame)
            await self.log("stdinfo", "Deployed! Rebooting device after boot config changes")
            await self.exec_command("sudo systemctl enable frameos.service")
            await self.exec_command("sudo reboot")
        else:
            await self.exec_command("sudo systemctl daemon-reload")
            await self.restart_service("frameos")
            await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, int(frame.id), type="stderr", line=str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)

def create_build_folder(temp_dir, build_id):
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    os.makedirs(build_dir, exist_ok=True)
    return build_dir
