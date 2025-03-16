from datetime import datetime, timezone
import json
import os
import random
import re
import shutil
import string
import subprocess
import tempfile
from typing import Any, Optional

import asyncssh
from packaging import version
import platform

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.drivers.devices import drivers_for_frame
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.models import get_apps_from_scenes
from app.models.assets import sync_assets
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection, exec_local_command
from app.models.apps import get_one_app_sources


async def deploy_frame(id: int, redis: Redis):
    """Queue a job to deploy a frame by ID."""
    await redis.enqueue_job("deploy_frame", id=id)


async def deploy_frame_task(ctx: dict[str, Any], id: int):
    """
    Main deployment logic for building, packaging, and deploying
    the Nim (FrameOS) application onto a target device via SSH.
    Changes made:
    1) If cross-compiling, only the final `frameos` binary (and vendor if needed)
       is uploaded, not the full C source code.
    2) Download minimal `libevdev.so.*` and `liblgpio.so.*` plus relevant headers
       from the Pi to local sysroot so we can link the same version that the Pi has.
    3) If apt fails for `liblgpio-dev`, compile from source on the Pi.
    """
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    frame = db.get(Frame, id)
    if not frame:
        raise Exception("Frame not found")

    try:
        if not frame.scenes or len(frame.scenes) == 0:
            raise Exception("You must have at least one installed scene to deploy.")

        if frame.status == 'deploying':
            raise Exception("Already deploying. Request again to force redeploy.")

        # We do not want to persist these fields if successful.
        frame_dict = frame.to_dict()
        frame_dict.pop("last_successful_deploy", None)
        frame_dict.pop("last_successful_deploy_at", None)

        frame.status = 'deploying'
        await update_frame(db, redis, frame)

        build_id = ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
        await log(db, redis, id, "stdout", f"Deploying frame {frame.name} with build id {build_id}")

        nim_path = find_nim_v2()
        ssh = await get_ssh_connection(db, redis, frame)

        # 1. Determine the remote CPU architecture
        await log(db, redis, id, "stdout", "- Getting target architecture")
        uname_output: list[str] = []
        await exec_command(db, redis, frame, ssh, "uname -m", uname_output)
        arch = "".join(uname_output).strip()
        cpu = get_target_cpu(arch)

        # For ARM Pi: pass extra march flags for ARMv6 or ARMv7
        pass_c_l_flags = ""
        if arch == "armv6l":
            pass_c_l_flags = "-march=armv6 -mfpu=vfp -mfloat-abi=hard -mtune=arm1176jzf-s -marm"
        elif arch == "armv7l":
            pass_c_l_flags = "-march=armv7-a -mfloat-abi=hard -mfpu=vfpv3 -mtune=cortex-a7 -marm"

        # 2. We will install needed dependencies on the Pi:
        #    build-essential is only needed if we end up *not* cross-compiling.
        #    But let's ensure the Pi can also run code that uses evdev, lgpio, etc.
        #    We'll also handle the possibility that `liblgpio-dev` is missing in apt.
        await log(db, redis, id, "stdout", "- Installing required packages on the Pi (if available)")
        # We'll do a helper function for apt installs:
        pkgs = ["ntp", "libevdev-dev"]
        # We do NOT add "build-essential" here by default. We'll do it conditionally if we need on-device build.
        for pkg in pkgs:
            await install_if_necessary(db, redis, frame, ssh, pkg, raise_on_error=False)

        # 2B. Try installing `liblgpio-dev`, if not found -> compile from source
        rc = await install_if_necessary(db, redis, frame, ssh, "liblgpio-dev", raise_on_error=False)
        if rc != 0:
            # We'll do the same approach we used for waveshare:
            await log(db, redis, id, "stdout", "--> Could not find liblgpio-dev. Installing from source.")
            command = (
                "if [ ! -f /usr/local/include/lgpio.h ]; then "
                "  rm -rf /tmp/lgpio-install && "
                "  mkdir -p /tmp/lgpio-install && "
                "  cd /tmp/lgpio-install && "
                "  wget -q -O v0.2.2.tar.gz https://github.com/joan2937/lg/archive/refs/tags/v0.2.2.tar.gz && "
                "  tar -xzf v0.2.2.tar.gz && "
                "  cd lg-0.2.2 && "
                "  make && "
                "  sudo make install && "
                "  sudo rm -rf /tmp/lgpio-install; "
                "fi"
            )
            await exec_command(db, redis, frame, ssh, command)

        # 2C. Scenes might require apt packages
        all_deps = get_apt_dependencies_from_scenes(db, redis, frame)
        for dep in all_deps:
            await install_if_necessary(db, redis, frame, ssh, dep)

        # 3. Check if we can cross-compile. Otherwise we’ll compile on the device.
        cross_compiler = get_cross_compiler_for_cpu(cpu)
        do_cross_compile = False
        if cross_compiler:
            rc, _, _ = await exec_local_command(db, redis, frame, f"{cross_compiler} --version", generate_log=False)
            if rc == 0:
                do_cross_compile = True

        # 4. If do_cross_compile, fetch minimal libs+headers from Pi for local linking
        #    (we only need libevdev & liblgpio plus their includes).
        local_sysroot_dir = None
        if do_cross_compile:
            await log(db, redis, id, "stdout", f"- Found cross-compiler '{cross_compiler}' for {cpu}")
            # TODO: delete this later? preserve it?
            local_sysroot_dir = os.path.join(tempfile.gettempdir(), f"sysroot_{frame.id}_{build_id}")
            # local_sysroot_dir = os.path.abspath(f"./sysroot_{frame.id}_{build_id}")
            if not os.path.exists(local_sysroot_dir):
                os.makedirs(local_sysroot_dir, exist_ok=True)

            # 4A. Download the relevant .so libs from the Pi
            #     We'll store them in e.g. sysroot/usr/lib/arm-linux-gnueabihf
            remote_libs_tar = f"/tmp/libs_{build_id}.tar.gz"
            cmd = (
                f"sudo tar -czf {remote_libs_tar} "
                f"/usr/lib/arm-linux-gnueabihf/libarmmem* "
                f"/usr/lib/arm-linux-gnueabihf/libm.so* "
                f"/usr/lib/arm-linux-gnueabihf/libd.so* "
                f"/usr/lib/arm-linux-gnueabihf/libpthread.so* "
                f"/usr/lib/arm-linux-gnueabihf/libc.so* "
                f"/usr/lib/arm-linux-gnueabihf/liblgpio.so* "
                "2>/dev/null || true"  # just in case some file is missing
            )
            await exec_command(db, redis, frame, ssh, cmd)
            local_libs_tar = os.path.join(local_sysroot_dir, "libs.tar.gz")
            await asyncssh.scp((ssh, remote_libs_tar), local_libs_tar)
            # Clean up remote tar
            await exec_command(db, redis, frame, ssh, f"sudo rm -f {remote_libs_tar}")

            # Extract to sysroot/usr/lib/arm-linux-gnueabihf
            sysroot_lib_dir = os.path.join(local_sysroot_dir, "usr", "lib", "arm-linux-gnueabihf")
            os.makedirs(sysroot_lib_dir, exist_ok=True)
            shutil.unpack_archive(local_libs_tar, local_sysroot_dir)
            os.remove(local_libs_tar)

            # 4B. Download relevant includes: often /usr/include/libevdev-1.0 & the lgpio.h
            remote_inc_tar = f"/tmp/includes_{build_id}.tar.gz"
            cmd = (
                f"sudo tar -czf {remote_inc_tar} "
                f"/usr/include/libevdev-1.0 "
                f"/usr/include/arm-linux-gnueabihf/lgpio.h "
                f"/usr/local/include/lgpio.h "
                "2>/dev/null || true"
            )
            await exec_command(db, redis, frame, ssh, cmd)
            local_inc_tar = os.path.join(local_sysroot_dir, "includes.tar.gz")
            await asyncssh.scp((ssh, remote_inc_tar), local_inc_tar)
            await exec_command(db, redis, frame, ssh, f"sudo rm -f {remote_inc_tar}")
            # Extract them into local sysroot
            shutil.unpack_archive(local_inc_tar, local_sysroot_dir)
            os.remove(local_inc_tar)

        # 5. Possibly handle low memory Pi if we are building on-device
        total_memory = 0
        try:
            mem_output: list[str] = []
            await exec_command(db, redis, frame, ssh, "free -m", mem_output)
            total_memory = int(mem_output[1].split()[1])
        except Exception as e:
            await log(db, redis, id, "stderr", str(e))
        low_memory = (total_memory < 512)

        if not do_cross_compile:
            # We may need to compile on the Pi
            await install_if_necessary(db, redis, frame, ssh, "build-essential")
            if low_memory:
                await log(db, redis, id, "stdout", "- Low memory device, stopping FrameOS for compilation")
                await exec_command(db, redis, frame, ssh, "sudo service frameos stop", raise_on_error=False)

        # 6. Generate Nim -> C code locally and optionally cross-compile
        drivers = drivers_for_frame(frame)
        with tempfile.TemporaryDirectory() as temp_dir:
            await log(db, redis, id, "stdout", "- Creating local Nim build (C sources)")

            build_dir, source_dir = create_build_folders(temp_dir, build_id)
            await make_local_modifications(db, redis, frame, source_dir)

            # Just produce C code + Makefile
            c_archive_path = await create_local_build_archive(
                db, redis, frame,
                build_dir, build_id, nim_path, source_dir, temp_dir, cpu,
                pass_c_l_flags,
                do_cross_compile
            )

            frameos_binary_path = os.path.join(build_dir, "frameos")

            if do_cross_compile and local_sysroot_dir:
                # 6A. Actually compile locally with cross_compiler
                await log(db, redis, id, "stdout", "- Cross compiling `frameos` with the Pi's libraries + headers")

                # Provide CFLAGS with path to local sysroot
                sysroot_flags = (
                    f"--sysroot={local_sysroot_dir} "
                    f"-I{local_sysroot_dir}/usr/include "
                    f"-L{local_sysroot_dir}/usr/lib/arm-linux-gnueabihf "
                )
                # We also apply our pass_c_l_flags (-march=...)
                # plus the libraries Nim might link: -levdev -llgpio
                make_cmd = (
                    f"cd {build_dir} && make clean && "
                    f"make -j$(nproc) CC={cross_compiler} "
                    f"\"SYSROOT={sysroot_flags}\" "
                )
                status, _, _ = await exec_local_command(db, redis, frame, make_cmd)
                if status != 0:
                    raise Exception("Cross-compilation with sysroot failed.")
            else:
                # 6B. On-device compile approach
                await exec_command(db, redis, frame, ssh, "mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
                await log(db, redis, id, "stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")

                # Upload the entire C code tar to compile on Pi
                await asyncssh.scp(
                    c_archive_path,
                    (ssh, f"/srv/frameos/build/build_{build_id}.tar.gz"),
                    recurse=False
                )
                await exec_command(
                    db, redis, frame, ssh,
                    f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz"
                )
                compile_cmd = (
                    f"cd /srv/frameos/build/build_{build_id} && "
                    "PARALLEL_MEM=$(awk '/MemTotal/{printf \"%.0f\\n\", $2/1024/250}' /proc/meminfo) && "
                    "PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && "
                    "make -j$PARALLEL"
                )
                await exec_command(db, redis, frame, ssh, compile_cmd)

            # 7. Upload final `frameos` executable (if cross-compiled), plus vendor if needed
            release_path = f"/srv/frameos/releases/release_{build_id}"
            if do_cross_compile:
                # We skip uploading the entire build_{build_id} folder. Just upload the `frameos`.
                await exec_command(db, redis, frame, ssh,
                                   f"mkdir -p {release_path}")
                # TODO: compress
                await asyncssh.scp(
                    frameos_binary_path,
                    (ssh, f"{release_path}/frameos"),
                    recurse=False
                )
                # If there's vendor code (e.g. inky) we still need to copy that to the Pi,
                # because e.g. the Python environment is needed at runtime.
                vendor_tar = None
                if requires_vendor_upload(drivers):
                    vendor_tar = os.path.join(temp_dir, f"vendor_{build_id}.tar.gz")
                    vendor_folder_temp = os.path.join(temp_dir, "vendor")
                    os.makedirs(vendor_folder_temp, exist_ok=True)
                    copy_vendor_folders(drivers, vendor_folder_temp)
                    shutil.make_archive(
                        base_name=os.path.join(temp_dir, f"vendor_{build_id}"),
                        format='gztar',
                        root_dir=temp_dir,
                        base_dir="vendor"
                    )
                    await exec_command(db, redis, frame, ssh, "mkdir -p /srv/frameos/build/vendor_temp")
                    await asyncssh.scp(vendor_tar,
                                       (ssh, f"/srv/frameos/build/vendor_temp/vendor_{build_id}.tar.gz"),
                                       recurse=False)
                    await exec_command(
                        db, redis, frame, ssh,
                        f"cd /srv/frameos/build/vendor_temp && "
                        f"tar -xzf vendor_{build_id}.tar.gz && rm vendor_{build_id}.tar.gz"
                    )
                    # Then we can move that vendor code to the new release
                    await exec_command(
                        db, redis, frame, ssh,
                        "mkdir -p /srv/frameos/vendor && "
                        "cp -r /srv/frameos/build/vendor_temp/vendor/* /srv/frameos/vendor/"
                    )
                    await exec_command(db, redis, frame, ssh, "rm -rf /srv/frameos/build/vendor_temp")

            else:
                # We compiled on the Pi. The final binary is at /srv/frameos/build/build_{build_id}/frameos
                await exec_command(db, redis, frame, ssh, f"mkdir -p {release_path}")
                await exec_command(
                    db, redis, frame, ssh,
                    f"cp /srv/frameos/build/build_{build_id}/frameos {release_path}/frameos"
                )

            # 8. Upload frame.json
            frame_json_data = (json.dumps(get_frame_json(db, frame), indent=4) + "\n").encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmpf:
                local_json_path = tmpf.name
                tmpf.write(frame_json_data)

            await asyncssh.scp(
                local_json_path,
                (ssh, f"{release_path}/frame.json"),
                recurse=False
            )
            os.remove(local_json_path)
            await log(db, redis, id, "stdout", f"> add {release_path}/frame.json")

            # 9. If inky vendor, set up Python venv on the Pi
            await install_inky_vendors(db, redis, frame, ssh, build_id, drivers)

            # Clean old builds if we did on-device compile
            if not do_cross_compile:
                await exec_command(db, redis, frame, ssh,
                                   "cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
                await exec_command(db, redis, frame, ssh,
                                   "cd /srv/frameos/build/cache && "
                                   "find . -type f \\( -atime +0 -a -mtime +0 \\) | xargs rm -rf")

            # We also remove old releases, except the current symlink
            await exec_command(db, redis, frame, ssh,
                               "cd /srv/frameos/releases && "
                               "ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" "
                               "| tail -n +11 | xargs rm -rf")

        # 10. systemd service, link new release
        with open("../frameos/frameos.service", "r") as f:
            service_contents = f.read().replace("%I", frame.ssh_user)
        service_data = service_contents.encode('utf-8')
        with tempfile.NamedTemporaryFile(suffix=".service", delete=False) as tmpservice:
            local_service_path = tmpservice.name
            tmpservice.write(service_data)
        await asyncssh.scp(
            local_service_path,
            (ssh, f"{release_path}/frameos.service"),
            recurse=False
        )
        os.remove(local_service_path)

        await exec_command(db, redis, frame, ssh,
                           f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state {release_path}/state")
        await exec_command(db, redis, frame, ssh,
                           f"sudo cp {release_path}/frameos.service /etc/systemd/system/frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo chown root:root /etc/systemd/system/frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo chmod 644 /etc/systemd/system/frameos.service")

        await exec_command(db, redis, frame, ssh,
                           f"rm -rf /srv/frameos/current && ln -s {release_path} /srv/frameos/current")

        # 11. Sync assets
        await sync_assets(db, redis, frame, ssh)

        # 12. Additional config (SPI, I2C, apt timers, etc.)
        await handle_additional_device_config(db, redis, frame, ssh, arch, drivers)

        frame.status = 'starting'
        frame.last_successful_deploy = frame_dict
        frame.last_successful_deploy_at = datetime.now(timezone.utc)

        # Possibly reboot if bootconfig lines changed
        must_reboot = drivers.get("bootconfig") and drivers["bootconfig"].needs_reboot
        await exec_command(db, redis, frame, ssh, "sudo systemctl daemon-reload")
        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos.service")

        if must_reboot:
            await update_frame(db, redis, frame)
            await log(db, redis, int(frame.id), "stdinfo", "Deployed! Rebooting device after boot config changes")
            await exec_command(db, redis, frame, ssh, "sudo reboot")
        else:
            await exec_command(db, redis, frame, ssh, "sudo systemctl restart frameos.service")
            await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos.service")
            await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            await remove_ssh_connection(db, redis, ssh, frame)


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

async def install_if_necessary(db: Session, redis: Redis, frame: Frame, ssh, pkg: str, raise_on_error=True) -> int:
    """
    Installs package `pkg` on the remote device if it's not already installed.
    Return code is from `exec_command`.
    """
    cmd = f"dpkg -l | grep -q \"^ii  {pkg}\" || sudo apt-get install -y {pkg}"
    return await exec_command(db, redis, frame, ssh, cmd, raise_on_error=raise_on_error)


def get_apt_dependencies_from_scenes(db: Session, redis: Redis, frame: Frame) -> set[str]:
    """
    Examine each scene's config for 'apt' dependencies in config.json
    and collect them all in a set.
    """
    all_deps = set()
    for scene in frame.scenes:
        try:
            for node in scene.get('nodes', []):
                try:
                    config: Optional[dict[str, Any]] = None
                    if node.get('type') == 'app':
                        app = node.get('data', {}).get('keyword')
                        if app:
                            json_config = get_one_app_sources(app).get('config.json')
                            if json_config:
                                config = json.loads(json_config)
                    elif node.get('type') == 'source':
                        json_config = node.get('sources', {}).get('config.json')
                        if json_config:
                            config = json.loads(json_config)
                    if config and config.get('apt'):
                        for dep in config['apt']:
                            all_deps.add(dep)
                except Exception:
                    pass
        except Exception:
            pass
    return all_deps


def get_target_cpu(arch: str) -> str:
    """
    Map 'uname -m' output to something Nim expects in --cpu
    and that we can match with cross compilers.
    """
    if arch in ("aarch64", "arm64"):
        return "arm64"
    elif arch in ("armv6l", "armv7l"):
        return "arm"
    elif arch == "i386":
        return "i386"
    # Fallback
    return "amd64"


def get_cross_compiler_for_cpu(cpu: str) -> Optional[str]:
    """
    Return the cross-compiler command for a given CPU,
    or None if there's no well-known cross-compiler for that CPU.
    For Pi Zero/1 (ARMv6) or Pi 2/3 (ARMv7) we guess 'arm-linux-gnueabihf-gcc'.
    For 64-bit Pi: 'aarch64-linux-gnu-gcc'.
    """
    if cpu == "arm64":
        return "aarch64-linux-gnu-gcc"
    elif cpu == "arm":
        return "arm-linux-gnueabihf-gcc"
    return None


def find_nim_v2():
    """
    Locate a Nim executable >= 2.0.0.
    Raises an exception if not found or if version < 2.0.0.
    """
    nim_path = find_nim_executable()
    if not nim_path:
        raise Exception("Nim executable not found")
    nim_ver = get_nim_version(nim_path)
    if not nim_ver or nim_ver < version.parse("2.0.0"):
        raise Exception("Nim 2.0.0 or higher is required")
    return nim_path


def find_nim_executable():
    common_paths = {
        'Windows': [
            'C:\\Program Files\\Nim\\bin\\nim.exe',
            'C:\\Nim\\bin\\nim.exe'
        ],
        'Darwin': [
            '/opt/homebrew/bin/nim',
            '/usr/local/bin/nim'
        ],
        'Linux': [
            '/usr/bin/nim',
            '/usr/local/bin/nim',
            '/opt/nim/bin/nim',
        ]
    }
    # If nim is in the PATH
    if is_executable_in_path('nim'):
        return 'nim'
    os_type = platform.system()
    for path in common_paths.get(os_type, []):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def is_executable_in_path(executable: str):
    try:
        subprocess.run([executable, '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except FileNotFoundError:
        return False


def get_nim_version(executable_path: str):
    try:
        result = subprocess.run([executable_path, '--version'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        output = result.stdout.split('\n')[0]
        parts = output.split()
        for p in parts:
            if re.match(r'^\d+(\.\d+){1,2}', p):
                return version.parse(p)
        return None
    except Exception as e:
        print(f"Error getting Nim version: {e}")
        return None


def create_build_folders(temp_dir, build_id):
    """
    Create local build directories to store Nim source + build artifacts.
    Returns (build_dir, source_dir).
    """
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    source_dir = os.path.join(temp_dir, "frameos")
    os.makedirs(source_dir, exist_ok=True)
    shutil.copytree("../frameos", source_dir, dirs_exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)
    return build_dir, source_dir


async def make_local_modifications(db: Session, redis: Redis,
                                   frame: Frame, source_dir: str):
    """
    Write out scene, app, driver code into the Nim sources
    according to the current frame config.
    """
    shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
    os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

    for node_id, sources in get_apps_from_scenes(list(frame.scenes)).items():
        app_id = "nodeapp_" + node_id.replace('-', '_')
        app_dir = os.path.join(source_dir, "src", "apps", app_id)
        os.makedirs(app_dir, exist_ok=True)
        for filename, code in sources.items():
            with open(os.path.join(app_dir, filename), "w") as f:
                f.write(code)

    for scene in frame.scenes:
        try:
            scene_source = write_scene_nim(frame, scene)
            safe_id = re.sub(r'\W+', '', scene.get('id', 'default'))
            with open(os.path.join(source_dir, "src", "scenes", f"scene_{safe_id}.nim"), "w") as f:
                f.write(scene_source)
        except Exception as e:
            await log(db, redis, int(frame.id), "stderr",
                      f"Error writing scene \"{scene.get('name','')}\" "
                      f"({scene.get('id','default')}): {e}")
            raise

    with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as f:
        source = write_scenes_nim(frame)
        f.write(source)
        if frame.debug:
            await log(db, redis, int(frame.id), "stdout", f"Generated scenes.nim:\n{source}")

    drivers = drivers_for_frame(frame)
    with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as f:
        source = write_drivers_nim(drivers)
        f.write(source)
        if frame.debug:
            await log(db, redis, int(frame.id), "stdout", f"Generated drivers.nim:\n{source}")

    # Waveshare driver code (if needed)
    if drivers.get("waveshare"):
        with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as wf:
            source = write_waveshare_driver_nim(drivers)
            wf.write(source)
            if frame.debug:
                await log(db, redis, int(frame.id), "stdout", f"Generated waveshare driver:\n{source}")


async def create_local_build_archive(
    db: Session,
    redis: Redis,
    frame: Frame,
    build_dir: str,
    build_id: str,
    nim_path: str,
    source_dir: str,
    temp_dir: str,
    cpu: str,
    pass_c_l_flags: str = "",
    do_cross_compile: bool = False
) -> str:
    """
    Run Nim to generate the C files (and Makefile scaffolding),
    then create a tar.gz of the build directory.
    Returns path to the .tar.gz.
    """
    drivers = drivers_for_frame(frame)
    # Copy vendor folder(s) if needed for e.g. Inky
    if inkyPython := drivers.get('inkyPython'):
        vendor_folder = inkyPython.vendor_folder or ""
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        local_from = f"../frameos/vendor/{vendor_folder}/"
        shutil.copytree(local_from,
                        os.path.join(build_dir, "vendor", vendor_folder),
                        dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

    if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
        vendor_folder = inkyHyperPixel2r.vendor_folder or ""
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        local_from = f"../frameos/vendor/{vendor_folder}/"
        shutil.copytree(local_from,
                        os.path.join(build_dir, "vendor", vendor_folder),
                        dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

    await log(db, redis, int(frame.id), "stdout", "- Generating Nim => C code for compilation.")

    debug_options = "--lineTrace:on" if frame.debug else ""
    extra_passes = ""
    if pass_c_l_flags:
        extra_passes = f'--passC:"{pass_c_l_flags}" --passL:"{pass_c_l_flags}"'

    cmd = (
        f"cd {source_dir} && nimble assets -y && nimble setup && "
        f"{nim_path} compile --os:linux --cpu:{cpu} "
        f"--compileOnly --genScript --nimcache:{build_dir} "
        f"{debug_options} {extra_passes} src/frameos.nim 2>&1"
    )

    status, out, err = await exec_local_command(db, redis, frame, cmd)
    if status != 0:
        # Attempt to parse any relevant final line for error location
        lines = (out or "").split("\n")
        filtered = [ln for ln in lines if ln.strip()]
        if filtered:
            last_line = filtered[-1]
            match = re.match(r'^(.*\.nim)\((\d+), (\d+)\),?.*', last_line)
            if match:
                fn = match.group(1)
                line_nr = int(match.group(2))
                column = int(match.group(3))
                source_abs = os.path.realpath(source_dir)
                final_path = os.path.realpath(os.path.join(source_dir, fn))
                if os.path.commonprefix([final_path, source_abs]) == source_abs:
                    rel_fn = final_path[len(source_abs) + 1:]
                    with open(final_path, "r") as of:
                        all_lines = of.readlines()
                    await log(db, redis, int(frame.id), "stdout",
                              f"Error in {rel_fn}:{line_nr}:{column}")
                    if 0 < line_nr <= len(all_lines):
                        line_text = all_lines[line_nr - 1]
                        await log(db, redis, int(frame.id), "stdout", f"Line {line_nr}: {line_text}")
                        caret_prefix = "......." + ('.' * (column - 1 + len(str(line_nr))))
                        await log(db, redis, int(frame.id), "stdout", f"{caret_prefix}^")
                else:
                    await log(db, redis, int(frame.id), "stdout",
                              f"Error in {fn}:{line_nr}:{column}")
        raise Exception("Failed to generate frameos sources")

    # Copy nimbase.h into build_dir
    nimbase_path = find_nimbase_file(nim_path)
    if not nimbase_path:
        raise Exception("nimbase.h not found")
    shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

    # Waveshare variant?
    if waveshare := drivers.get('waveshare'):
        if waveshare.variant:
            variant_folder = get_variant_folder(waveshare.variant)
            util_files = ["Debug.h", "DEV_Config.c", "DEV_Config.h"]
            for uf in util_files:
                shutil.copy(
                    os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, uf),
                    os.path.join(build_dir, uf)
                )
            # color e-paper variants need bc-based filenames
            # e.g. EPD_2in9b -> EPD_2in9bc.(c/h)
            if waveshare.variant in [
                "EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c",
                "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c",
                "EPD_7in5b", "EPD_7in5c"
            ]:
                c_file = re.sub(r'[bc]', 'bc', waveshare.variant)
                variant_files = [f"{waveshare.variant}.nim", f"{c_file}.c", f"{c_file}.h"]
            else:
                variant_files = [
                    f"{waveshare.variant}.nim",
                    f"{waveshare.variant}.c",
                    f"{waveshare.variant}.h"
                ]
            for vf in variant_files:
                shutil.copy(
                    os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, vf),
                    os.path.join(build_dir, vf)
                )

    # Generate the final Makefile
    with open(os.path.join(build_dir, "Makefile"), "w") as mk:
        script_path = os.path.join(build_dir, "compile_frameos.sh")
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
        compiler_flags: list[str] = []
        if os.path.isfile(script_path):
            with open(script_path, "r") as sc:
                lines_sc = sc.readlines()
            for line in lines_sc:
                if " -o frameos " in line and " -l" in line:
                    # This line typically has -o frameos -lpthread -lm etc.
                    linker_flags = [
                        fl.strip() for fl in line.split(' ')
                        if fl.startswith('-') and fl != '-o'
                    ]
                elif " -c " in line and not compiler_flags:
                    # Nim's compile command for each .c
                    compiler_flags = [
                        fl for fl in line.split(' ')
                        if fl.startswith('-') and not fl.startswith('-I')
                        and fl not in ['-o', '-c', '-D']
                    ]

        if do_cross_compile:
            if cpu == "arm":
                linker_flags += ["-L/usr/lib/arm-linux-gnueabihf"]
                compiler_flags += ["-I/usr/include/arm-linux-gnueabihf"]
            elif cpu == "arm64":
                linker_flags += ["-L/usr/lib/aarch64-linux-gnu"]
                compiler_flags += ["-I/usr/include/aarch64-linux-gnu"]

        # Base Makefile template
        with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as mf_in:
            lines_make = mf_in.readlines()
        for ln in lines_make:
            if ln.startswith("LIBS = "):
                ln = ("LIBS = -L. " + " ".join(linker_flags) + "\n")
            if ln.startswith("CFLAGS = "):
                cf = [f for f in compiler_flags if f != '-c']
                ln = "CFLAGS = " + " ".join(cf) + "\n"
            mk.write(ln)

    # Make a tar of the entire build_dir
    archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
    zip_base = os.path.join(temp_dir, f"build_{build_id}")
    shutil.make_archive(zip_base, 'gztar', temp_dir, f"build_{build_id}")
    return archive_path


def find_nimbase_file(nim_executable: str):
    nimbase_paths: list[str] = []
    try:
        # Attempt nim dump to see if it reveals the Nim lib location
        nim_dump_output = subprocess.run(
            [nim_executable, "dump"], text=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        ).stderr
        nimbase_paths.extend(line for line in nim_dump_output.splitlines() if 'lib' in line)
    except subprocess.CalledProcessError as e:
        print(f"Error running 'nim dump': {e}")

    os_type = platform.system()
    if os_type == 'Darwin':
        nimbase_paths.append('/usr/local/lib/nim')
    elif os_type == 'Linux':
        nimbase_paths.append('/usr/lib/nim')
        nimbase_paths.append('/opt/nim/lib')
    elif os_type == 'Windows':
        nimbase_paths.append('C:\\Nim\\lib')

    if os_type == 'Darwin':
        base_dir = '/opt/homebrew/Cellar/nim/'
        if os.path.exists(base_dir):
            for verdir in os.listdir(base_dir):
                nb_file = os.path.join(base_dir, verdir, 'nim', 'lib', 'nimbase.h')
                if os.path.isfile(nb_file):
                    return nb_file

    for path in nimbase_paths:
        nb_file = os.path.join(path, 'nimbase.h')
        if os.path.isfile(nb_file):
            return nb_file
    return None


def requires_vendor_upload(drivers: dict) -> bool:
    """
    Returns True if we have inky drivers that require uploading Python code to the Pi.
    """
    return any(k in drivers for k in ["inkyPython", "inkyHyperPixel2r"])


def copy_vendor_folders(drivers: dict, vendor_folder_temp: str):
    """
    Copies Inky or other vendor folders into a temp area for tar/transfer.
    """
    if inkyPython := drivers.get('inkyPython'):
        vf = inkyPython.vendor_folder or ""
        local_from = f"../frameos/vendor/{vf}/"
        dest = os.path.join(vendor_folder_temp, vf)
        shutil.copytree(local_from, dest, dirs_exist_ok=True)
        # remove venv, __pycache__ to reduce size
        shutil.rmtree(os.path.join(dest, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(dest, "__pycache__"), ignore_errors=True)

    if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
        vf = inkyHyperPixel2r.vendor_folder or ""
        local_from = f"../frameos/vendor/{vf}/"
        dest = os.path.join(vendor_folder_temp, vf)
        shutil.copytree(local_from, dest, dirs_exist_ok=True)
        shutil.rmtree(os.path.join(dest, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(dest, "__pycache__"), ignore_errors=True)


async def install_inky_vendors(db: Session, redis: Redis, frame: Frame, ssh, build_id: str, drivers: dict):
    """
    If the user wants inky/HyperPixel drivers, set up the Python venv on the Pi.
    (We assume the vendor folder was either included in the on-device build tar
     or scp'd separately if cross-compiled.)
    """
    if inkyPython := drivers.get("inkyPython"):
        await install_if_necessary(db, redis, frame, ssh, "python3-pip")
        await install_if_necessary(db, redis, frame, ssh, "python3-venv")
        cmd = (
            f"cd /srv/frameos/vendor/{inkyPython.vendor_folder} && "
            "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
            "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
            "(echo '> env/bin/pip3 install -r requirements.txt' && "
            "env/bin/pip3 install -r requirements.txt && "
            "sha256sum requirements.txt > requirements.txt.sha256sum))"
        )
        await exec_command(db, redis, frame, ssh, cmd)

    if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
        await install_if_necessary(db, redis, frame, ssh, "python3-dev")
        await install_if_necessary(db, redis, frame, ssh, "python3-pip")
        await install_if_necessary(db, redis, frame, ssh, "python3-venv")
        cmd = (
            f"cd /srv/frameos/vendor/{inkyHyperPixel2r.vendor_folder} && "
            "([ ! -d env ] && python3 -m venv env || echo 'env exists') && "
            "(sha256sum -c requirements.txt.sha256sum 2>/dev/null || "
            "(echo '> env/bin/pip3 install -r requirements.txt' && "
            "env/bin/pip3 install -r requirements.txt && "
            "sha256sum requirements.txt > requirements.txt.sha256sum))"
        )
        await exec_command(db, redis, frame, ssh, cmd)


async def handle_additional_device_config(db: Session, redis: Redis, frame: Frame, ssh, arch: str, drivers: dict):
    """
    E.g. enabling I2C, SPI, or messing with apt-daily timers for low memory devices,
    plus appending lines to /boot/config.txt if needed.
    """
    mem_output: list[str] = []
    await exec_command(db, redis, frame, ssh, "free -m", mem_output, raise_on_error=False)
    total_memory = 0
    try:
        total_memory = int(mem_output[1].split()[1])
    except:
        pass
    low_memory = (total_memory < 512)

    boot_config = "/boot/config.txt"
    if await exec_command(db, redis, frame, ssh, "test -f /boot/firmware/config.txt", raise_on_error=False) == 0:
        boot_config = "/boot/firmware/config.txt"

    # i2c
    if drivers.get("i2c"):
        await exec_command(db, redis, frame, ssh,
                           f'grep -q "^dtparam=i2c_vc=on$" {boot_config} '
                           f'|| echo "dtparam=i2c_vc=on" | sudo tee -a {boot_config}')
        await exec_command(db, redis, frame, ssh,
                           'command -v raspi-config > /dev/null && '
                           'sudo raspi-config nonint get_i2c | grep -q "1" && { '
                           '  sudo raspi-config nonint do_i2c 0; echo "I2C enabled"; '
                           '} || echo "I2C already enabled"')

    # spi
    if drivers.get("spi"):
        await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 0')
    elif drivers.get("noSpi"):
        await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 1')

    # Possibly disable apt timers on low memory
    if low_memory:
        await exec_command(
            db, redis, frame, ssh,
            "systemctl is-enabled apt-daily-upgrade.timer 2>/dev/null | grep -q masked || "
            "("
            "  sudo systemctl mask apt-daily-upgrade && "
            "  sudo systemctl mask apt-daily && "
            "  sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service"
            ")"
        )

    # Reboot or auto-restart logic from frame.reboot
    if frame.reboot and frame.reboot.get('enabled') == 'true':
        cron_schedule = frame.reboot.get('crontab', '0 0 * * *')
        if frame.reboot.get('type') == 'raspberry':
            crontab = f"{cron_schedule} root /sbin/shutdown -r now"
        else:
            crontab = f"{cron_schedule} root systemctl restart frameos.service"
        await exec_command(db, redis, frame, ssh, f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
    else:
        await exec_command(db, redis, frame, ssh, "sudo rm -f /etc/cron.d/frameos-reboot")

    # If we have lines to add to /boot/config.txt:
    if drivers.get("bootconfig"):
        lines = drivers["bootconfig"].lines
        must_reboot = False
        for line in lines:
            cmd = f'grep -q "^{line}" {boot_config}'
            if await exec_command(db, redis, frame, ssh, cmd, raise_on_error=False) != 0:
                # not found in boot_config
                await exec_command(
                    db, redis, frame, ssh,
                    f'echo "{line}" | sudo tee -a {boot_config}',
                    log_output=False
                )
                must_reboot = True
        # We store that in the driver dict so the main deploy logic can check:
        drivers["bootconfig"].needs_reboot = must_reboot
