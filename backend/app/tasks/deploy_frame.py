import json
import hashlib
import os
import random
import re
import shutil
import string
import subprocess
import tempfile
from typing import Any

from arq import ArqRedis as Redis
from packaging import version

import platform

from io import StringIO

from scp import SCPClient

from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim, write_scenes_nim
from app.drivers.devices import drivers_for_device
from app.drivers.waveshare import write_waveshare_driver_nim, get_variant_folder
from app.models import get_apps_from_scenes
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection, exec_local_command
from sqlalchemy.orm import Session

async def deploy_frame(id: int, redis: Redis):
    await redis.enqueue_job("deploy_frame", id=id)

async def deploy_frame_task(ctx: dict[str, Any], id: int):
    db: Session = ctx['db']
    redis: Redis = ctx['redis']

    ssh = None
    try:
        frame = db.get(Frame, id)

        if frame is None:
            raise Exception("Frame not found")

        if frame.scenes is None or len(frame.scenes) == 0:
            raise Exception("You must have at least one installed scene to deploy a frame.")

        if frame.status == 'deploying':
            raise Exception("Already deploying, will not deploy again. Request again to force deploy.")

        frame.status = 'deploying'
        await update_frame(db, redis, frame)

        # TODO: add the concept of builds into the backend (track each build in the database)
        build_id = ''.join(random.choice(string.ascii_lowercase) for i in range(12))
        await log(db, redis, id, "stdout", f"Deploying frame {frame.name} with build id {build_id}")

        nim_path = find_nim_v2()
        ssh = await get_ssh_connection(db, redis, frame)

        async def install_if_necessary(package: str, raise_on_error = True) -> int:
            """If a package is not installed, install it."""
            return await exec_command(db, redis, frame, ssh, f"dpkg -l | grep -q \"^ii  {package}\" || sudo apt-get install -y {package}", raise_on_error=raise_on_error)

        with tempfile.TemporaryDirectory() as temp_dir:
            await log(db, redis, id, "stdout", "- Getting target architecture")
            uname_output: list[str] = []
            await exec_command(db, redis, frame, ssh, "uname -m", uname_output)
            arch = "".join(uname_output).strip()
            if arch == "aarch64" or arch == "arm64":
                cpu = "arm64"
            elif arch == "armv6l" or arch == "armv7l":
                cpu = "arm"
            elif arch == "i386":
                cpu = "i386"
            else:
                cpu = "amd64"

            total_memory = 0
            try:
                mem_output: list[str] = []
                await exec_command(db, redis, frame, ssh, "free -m", mem_output)
                total_memory = int(mem_output[1].split()[1])
            except Exception as e:
                await log(db, redis, id, "stderr", str(e))
            low_memory = total_memory < 512

            drivers = drivers_for_device(frame.device)

            # create a build .tar.gz
            await log(db, redis, id, "stdout", "- Copying build folders")
            build_dir, source_dir = create_build_folders(temp_dir, build_id)
            await log(db, redis, id, "stdout", "- Applying local modifications")
            await make_local_modifications(db, redis, frame, source_dir)
            await log(db, redis, id, "stdout", "- Creating build archive")
            archive_path = await create_local_build_archive(db, redis, frame, build_dir, build_id, nim_path, source_dir, temp_dir, cpu)

            if low_memory:
                await log(db, redis, id, "stdout", "- Low memory detected, stopping FrameOS for compilation")
                await exec_command(db, redis, frame, ssh, "sudo service frameos stop", raise_on_error=False)

            with SCPClient(ssh.get_transport()) as scp:
                # build the release on the server
                await install_if_necessary("ntp")
                await install_if_necessary("build-essential")
                if drivers.get("evdev"):
                    await install_if_necessary("libevdev-dev")
                if drivers.get('waveshare') or drivers.get('gpioButton'):
                    if await exec_command(db, redis, frame, ssh, '[[ -f "/usr/local/include/lgpio.h" || -f "/usr/include/lgpio.h" ]] && exit 0 || exit 1', raise_on_error=False) != 0:
                        if await install_if_necessary("liblgpio-dev", raise_on_error=False) != 0:
                            await log(db, redis, id, "stdout", "--> Could not find liblgpio-dev package, installing from source")
                            command = "if [ ! -f /usr/local/include/lgpio.h ]; then "\
                                        "rm -rf /tmp/lgpio-install && "\
                                        "mkdir -p /tmp/lgpio-install && "\
                                        "cd /tmp/lgpio-install && "\
                                        "wget -q -O v0.2.2.tar.gz https://github.com/joan2937/lg/archive/refs/tags/v0.2.2.tar.gz && "\
                                        "tar -xzf v0.2.2.tar.gz && "\
                                        "cd lg-0.2.2 && "\
                                        "make && "\
                                        "sudo make install && "\
                                        "sudo rm -rf /tmp/lgpio-install; "\
                                        "fi"
                            await exec_command(db, redis, frame, ssh, command)

                await exec_command(db, redis, frame, ssh, "if [ ! -d /srv/frameos/ ]; then sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; fi")
                await exec_command(db, redis, frame, ssh, "mkdir -p /srv/frameos/build/ /srv/frameos/logs/")
                await log(db, redis, id, "stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")
                scp.put(archive_path, f"/srv/frameos/build/build_{build_id}.tar.gz")
                await exec_command(db, redis, frame, ssh, f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz")
                await exec_command(db, redis, frame, ssh, f"cd /srv/frameos/build/build_{build_id} && PARALLEL_MEM=$(awk '/MemTotal/{{printf \"%.0f\\n\", $2/1024/250}}' /proc/meminfo) && PARALLEL=$(($PARALLEL_MEM < $(nproc) ? $PARALLEL_MEM : $(nproc))) && make -j$PARALLEL")
                await exec_command(db, redis, frame, ssh, f"mkdir -p /srv/frameos/releases/release_{build_id}")
                await exec_command(db, redis, frame, ssh, f"cp /srv/frameos/build/build_{build_id}/frameos /srv/frameos/releases/release_{build_id}/frameos")
                await log(db, redis, id, "stdout", f"> add /srv/frameos/releases/release_{build_id}/frame.json")
                scp.putfo(StringIO(json.dumps(get_frame_json(db, frame), indent=4) + "\n"), f"/srv/frameos/releases/release_{build_id}/frame.json")

                # TODO: abstract driver-specific install steps
                # TODO: abstract vendor logic
                if inkyPython := drivers.get("inkyPython"):
                    await exec_command(db, redis, frame, ssh, f"mkdir -p /srv/frameos/vendor && cp -r /srv/frameos/build/build_{build_id}/vendor/inkyPython /srv/frameos/vendor/")
                    await install_if_necessary("python3-pip")
                    await install_if_necessary("python3-venv")
                    await exec_command(db, redis, frame, ssh, f"cd /srv/frameos/vendor/{inkyPython.vendor_folder} && ([ ! -d env ] && python3 -m venv env || echo 'env exists') && (sha256sum -c requirements.txt.sha256sum 2>/dev/null || (echo '> env/bin/pip3 install -r requirements.txt' && env/bin/pip3 install -r requirements.txt && sha256sum requirements.txt > requirements.txt.sha256sum))")

                if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
                    await exec_command(db, redis, frame, ssh, f"mkdir -p /srv/frameos/vendor && cp -r /srv/frameos/build/build_{build_id}/vendor/inkyHyperPixel2r /srv/frameos/vendor/")
                    await install_if_necessary("python3-dev")
                    await install_if_necessary("python3-pip")
                    await install_if_necessary("python3-venv")
                    await exec_command(db, redis, frame, ssh, f"cd /srv/frameos/vendor/{inkyHyperPixel2r.vendor_folder} && ([ ! -d env ] && python3 -m venv env || echo 'env exists') && (sha256sum -c requirements.txt.sha256sum 2>/dev/null || (echo '> env/bin/pip3 install -r requirements.txt' && env/bin/pip3 install -r requirements.txt && sha256sum requirements.txt > requirements.txt.sha256sum))")

                # add frameos.service
                with open("../frameos/frameos.service", "r") as file:
                    service_contents = file.read().replace("%I", frame.ssh_user)
                with SCPClient(ssh.get_transport()) as scp:
                    scp.putfo(StringIO(service_contents), f"/srv/frameos/releases/release_{build_id}/frameos.service")
                await exec_command(db, redis, frame, ssh, f"mkdir -p /srv/frameos/state && ln -s /srv/frameos/state /srv/frameos/releases/release_{build_id}/state")
                await exec_command(db, redis, frame, ssh, f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service /etc/systemd/system/frameos.service")
                await exec_command(db, redis, frame, ssh, "sudo chown root:root /etc/systemd/system/frameos.service")
                await exec_command(db, redis, frame, ssh, "sudo chmod 644 /etc/systemd/system/frameos.service")

            # swap out the release
            await exec_command(db, redis, frame, ssh, f"rm -rf /srv/frameos/current && ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current")

            # Make sure /srv/assets is writable, if not create it and assign to our user
            assets_path = frame.assets_path or "/srv/assets"
            await exec_command(db, redis, frame, ssh, f"if [ ! -d {assets_path} ]; then sudo mkdir -p {assets_path} && sudo chown $(whoami):$(whoami) {assets_path}; elif [ ! -w {assets_path} ]; then echo 'User does not have write access to {assets_path}. Changing ownership...'; sudo chown $(whoami):$(whoami) {assets_path}; fi")

            # clean old build and release and cache folders
            await exec_command(db, redis, frame, ssh, "cd /srv/frameos/build && ls -dt1 build_* | tail -n +11 | xargs rm -rf")
            await exec_command(db, redis, frame, ssh, "cd /srv/frameos/build/cache && find . -type f \( -atime +0 -a -mtime +0 \) | xargs rm -rf")
            await exec_command(db, redis, frame, ssh, "cd /srv/frameos/releases && ls -dt1 release_* | grep -v \"$(basename $(readlink ../current))\" | tail -n +11 | xargs rm -rf")

        if drivers.get("i2c"):
            await exec_command(db, redis, frame, ssh, 'grep -q "^dtparam=i2c_vc=on$" /boot/config.txt || echo "dtparam=i2c_vc=on" | sudo tee -a /boot/config.txt')
            await exec_command(db, redis, frame, ssh, 'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1" && { sudo raspi-config nonint do_i2c 0; echo "I2C is now enabled"; } || echo "I2C is already enabled"')

        if drivers.get("spi"):
            await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 0')
        elif drivers.get("noSpi"):
            await exec_command(db, redis, frame, ssh, 'sudo raspi-config nonint do_spi 1')

        if low_memory:
            # disable apt-daily-upgrade (sudden +70mb memory usage, might lead a Zero W 2 to endlessly swap)
            await exec_command(db, redis, frame, ssh, "sudo systemctl mask apt-daily-upgrade && sudo systemctl mask apt-daily && sudo systemctl disable apt-daily.service apt-daily.timer apt-daily-upgrade.timer apt-daily-upgrade.service")
            # # disable swap while we're at it
            # await exec_command(db, redis, frame, ssh, "sudo systemctl disable dphys-swapfile.service")

        if frame.reboot and frame.reboot.get('enabled') == 'true':
            cron_schedule = frame.reboot.get('crontab', '0 0 * * *')
            if frame.reboot.get('type') == 'raspberry':
                crontab = f"{cron_schedule} root /sbin/shutdown -r now"
            else:
                crontab = f"{cron_schedule} root systemctl restart frameos.service"
            await exec_command(db, redis, frame, ssh, f"echo '{crontab}' | sudo tee /etc/cron.d/frameos-reboot")
        else:
            await exec_command(db, redis, frame, ssh, "sudo rm -f /etc/cron.d/frameos-reboot")

        # restart
        await exec_command(db, redis, frame, ssh, "sudo systemctl daemon-reload")
        await exec_command(db, redis, frame, ssh, "sudo systemctl enable frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl restart frameos.service")
        await exec_command(db, redis, frame, ssh, "sudo systemctl status frameos.service")

        frame.status = 'starting'
        await update_frame(db, redis, frame)

    except Exception as e:
        await log(db, redis, id, "stderr", str(e))
        if frame is not None:
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
    finally:
        if ssh is not None:
            ssh.close()
            if frame is not None:
                await log(db, redis, int(frame.id), "stdinfo", "SSH connection closed")
            remove_ssh_connection(ssh)


def find_nim_v2():
    nim_path = find_nim_executable()
    if not nim_path:
        raise Exception("Nim executable not found")
    nim_version = get_nim_version(nim_path)
    if not nim_version or nim_version < version.parse("2.0.0"):
        raise Exception("Nim version 2.0.0 or higher is required")
    return nim_path


def create_build_folders(temp_dir, build_id):
    build_dir = os.path.join(temp_dir, f"build_{build_id}")
    source_dir = os.path.join(temp_dir, "frameos")
    # 1. copy the frameos folder to the temp folder
    os.makedirs(source_dir, exist_ok=True)
    shutil.copytree("../frameos", source_dir, dirs_exist_ok=True)
    # 2. make a new build folder with the build_id
    os.makedirs(build_dir, exist_ok=True)
    return build_dir, source_dir


async def make_local_modifications(db: Session, redis: Redis, frame: Frame, source_dir: str):
    shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
    os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

    # write all source apps
    for node_id, sources in get_apps_from_scenes(list(frame.scenes)).items():
        app_id = "nodeapp_" + node_id.replace('-', '_')
        app_dir = os.path.join(source_dir, "src", "apps", app_id)
        os.makedirs(app_dir, exist_ok=True)
        for file, source in sources.items():
            with open(os.path.join(app_dir, file), "w") as file:
                file.write(source)

    # only one scene called "default" for now
    for scene in frame.scenes:
        try:
            scene_source = write_scene_nim(frame, scene)
            id = re.sub(r'\W+', '', scene.get('id', 'default'))
            with open(os.path.join(source_dir, "src", "scenes", f"scene_{id}.nim"), "w") as file:
                file.write(scene_source)
        except Exception as e:
            await log(db, redis, int(frame.id), "stderr", f"Error writing scene \"{scene.get('name', '')}\" ({scene.get('id', 'default')}): {e}")
            raise
    with open(os.path.join(source_dir, "src", "scenes", "scenes.nim"), "w") as file:
        file.write(write_scenes_nim(frame))

    drivers = drivers_for_device(frame.device)
    with open(os.path.join(source_dir, "src", "drivers", "drivers.nim"), "w") as file:
        drivers_nim = write_drivers_nim(drivers)
        file.write(drivers_nim)
    if drivers.get("waveshare"):
        with open(os.path.join(source_dir, "src", "drivers", "waveshare", "driver.nim"), "w") as file:
            drivers_nim = write_waveshare_driver_nim(drivers)
            file.write(drivers_nim)

def compile_line_md5(input: str) -> str:
    words = []
    ignore_next = False
    # The -I paths contain temporary folders, making this non-deterministic. So we remove them.
    for word in input.split(' '):
        if word == '-I':
            ignore_next = True
        elif ignore_next or word.startswith("-I"):
            pass
        else:
            words.append(word)
    encoded_string = " ".join(words).encode()
    hash_object = hashlib.md5(encoded_string)
    md5_hash = hash_object.hexdigest()
    return md5_hash

async def create_local_build_archive(db: Session, redis: Redis, frame: Frame, build_dir: str, build_id: str, nim_path: str, source_dir: str, temp_dir: str, cpu: str):
    # TODO: abstract driver-specific vendor steps
    drivers = drivers_for_device(frame.device)
    if inkyPython := drivers.get('inkyPython'):
        vendor_folder = inkyPython.vendor_folder or ""
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        shutil.copytree(f"../frameos/vendor/{vendor_folder}/", os.path.join(build_dir, "vendor", vendor_folder), dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)
    if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
        vendor_folder = inkyHyperPixel2r.vendor_folder or ""
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        shutil.copytree(f"../frameos/vendor/{vendor_folder}/", os.path.join(build_dir, "vendor", vendor_folder), dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", vendor_folder, "__pycache__"), ignore_errors=True)

    # Tell a white lie
    await log(db, redis, int(frame.id), "stdout", "- No cross compilation. Generating source code for compilation on frame.")

    # run "nim c --os:linux --cpu:arm64 --compileOnly --genScript --nimcache:tmp/build_1 src/frameos.nim"
    debug_options = ""
    if frame.debug:
        debug_options = "--lineTrace:on"
    status, out, err = await exec_local_command(
        db,
        redis,
        frame,
        f"cd {source_dir} && nimble assets -y && nimble setup && {nim_path} compile --os:linux --cpu:{cpu} --compileOnly --genScript --nimcache:{build_dir} {debug_options} src/frameos.nim 2>&1"
    )
    if status != 0:
        last_line = [line for line in (out or "").split("\n") if line != ''][-1]
        if match := re.match(r'^(.*\.nim)\((\d+), (\d+)\),?.*', last_line):
            filename = match.group(1)
            line_nr = int(match.group(2))
            column = int(match.group(3))
            source_path = os.path.realpath(source_dir)
            final_path = os.path.realpath(os.path.join(source_dir, filename))
            if os.path.commonprefix([final_path, source_path]) == source_path:
                filename = final_path[len(source_path) + 1:]
                with open(final_path, "r") as open_file:
                    lines = open_file.readlines()
                await log(db, redis, int(frame.id), "stdout", f"Error in {filename}:{line_nr}:{column}")
                await log(db, redis, int(frame.id), "stdout", f"Line {line_nr}: {lines[line_nr - 1]}")
                await log(db, redis, int(frame.id), "stdout", f".......{'.' * (column - 1 + len(str(line_nr)))}^")
            else:
                await log(db, redis, int(frame.id), "stdout", f"Error in {filename}:{line_nr}:{column}")

        raise Exception("Failed to generate frameos sources")

    # Copy the file "nimbase.h" to "build_1/nimbase.h"
    nimbase_path = find_nimbase_file(nim_path)
    if not nimbase_path:
        raise Exception("nimbase.h not found")
    shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

    if waveshare := drivers.get('waveshare'):
        if waveshare.variant:
            variant_folder = get_variant_folder(waveshare.variant)
            util_files = ["Debug.h", "DEV_Config.c", "DEV_Config.h"]
            for file in util_files:
                from_path = os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, file)
                to_path = os.path.join(build_dir, file)
                shutil.copy(from_path, to_path)

            if waveshare.variant in ["EPD_2in9b", "EPD_2in9c", "EPD_2in13b", "EPD_2in13c", "EPD_4in2b", "EPD_4in2c", "EPD_5in83b", "EPD_5in83c", "EPD_7in5b", "EPD_7in5c"]:
                c_file = re.sub(r'[bc]', 'bc', waveshare.variant)
                variant_files = [f"{waveshare.variant}.nim", f"{c_file}.c", f"{c_file}.h"]
            else:
                variant_files = [f"{waveshare.variant}.nim", f"{waveshare.variant}.c", f"{waveshare.variant}.h"]

            for file in variant_files:
                shutil.copy(os.path.join(source_dir, "src", "drivers", "waveshare", variant_folder, file), os.path.join(build_dir, file))

    # Create Makefile
    with open(os.path.join(build_dir, "Makefile"), "w") as makefile_file:
        # Read the compilation flags from the generated script
        script_path = os.path.join(build_dir, "compile_frameos.sh")
        linker_flags = ["-pthread", "-lm", "-lrt", "-ldl"]
        compiler_flags: list[str] = []
        with open(script_path, "r") as script:
            lines = script.readlines()
        for line in lines:
            if " -o frameos " in line and " -l" in line:
                linker_flags = [flag.strip() for flag in line.split(' ') if flag.startswith('-') and flag != '-o']
            elif " -c " in line and len(compiler_flags) == 0:
                compiler_flags = [flag for flag in line.split(' ') if flag.startswith('-') and not flag.startswith('-I') and flag not in ['-o', '-c', '-D']]

        # Read the Makefile from ../frameos/tools/nimc.Makefile
        with open(os.path.join(source_dir, "tools", "nimc.Makefile"), "r") as makefile:
            lines = makefile.readlines()
        for line in lines:
            if line.startswith("LIBS = "):
                line = "LIBS = -L. " + (" ".join(linker_flags)) + "\n"
            if line.startswith("CFLAGS = "):
                line = "CFLAGS = " + (" ".join([f for f in compiler_flags if f != '-c'])) + "\n"
            makefile_file.write(line)

    # 7. Zip it up "(cd tmp && tar -czf ./build_1.tar.gz build_1)"
    archive_path = os.path.join(temp_dir, f"build_{build_id}.tar.gz")
    zip_base_path = os.path.join(temp_dir, f"build_{build_id}")
    shutil.make_archive(zip_base_path, 'gztar', temp_dir, f"build_{build_id}")
    return archive_path

def find_nim_executable():
    # Common paths for nim executable based on the operating system
    common_paths = {
        'Windows': [
            'C:\\Program Files\\Nim\\bin\\nim.exe',
            'C:\\Nim\\bin\\nim.exe'
        ],
        'Darwin': [  # macOS
            '/opt/homebrew/bin/nim',
            '/usr/local/bin/nim'
        ],
        'Linux': [
            '/usr/bin/nim',
            '/usr/local/bin/nim',
            '/opt/nim/bin/nim',
        ]
    }

    # Check if nim is in the PATH
    if is_executable_in_path('nim'):
        return 'nim'  # nim is in the PATH

    # If not in PATH, check common paths based on the OS
    os_type = platform.system()
    for path in common_paths.get(os_type, []):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path

    return None  # nim not found

def is_executable_in_path(executable):
    try:
        subprocess.run([executable, '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except FileNotFoundError:
        return False


def get_nim_version(executable_path):
    try:
        result = subprocess.run([executable_path, '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        # Example output: "Nim Compiler Version 1.4.8 [Linux: amd64]"
        output = result.stdout.split('\n')[0]
        version_str = output.split()[3]
        return version.parse(version_str)
    except Exception as e:
        print(f"An error occurred while getting Nim version: {e}")
        return None


def find_nimbase_file(nim_executable: str):
    nimbase_paths: list[str] = []

    # Try to get paths from 'nim dump'
    try:
        nim_dump_output = subprocess.run([nim_executable, "dump"], text=True,
                                         stdout=subprocess.DEVNULL,
                                         stderr=subprocess.PIPE).stderr
        # Extract paths that might contain 'nimbase.h'
        nimbase_paths.extend(line for line in nim_dump_output.splitlines() if 'lib' in line)
    except subprocess.CalledProcessError as e:
        print(f"Error running 'nim dump': {e}")

    # Add common paths based on the operating system
    os_type = platform.system()
    if os_type == 'Darwin':  # macOS
        nimbase_paths.append('/usr/local/lib/nim')
    elif os_type == 'Linux':
        nimbase_paths.append('/usr/lib/nim')
        nimbase_paths.append('/opt/nim/lib')
    elif os_type == 'Windows':
        nimbase_paths.append('C:\\Nim\\lib')

    # Search for nimbase.h in the collected paths
    for path in nimbase_paths:
        nimbase_file = os.path.join(path, 'nimbase.h')
        if os.path.isfile(nimbase_file):
            return nimbase_file

    if os_type == 'Darwin':  # macOS
        base_dir = '/opt/homebrew/Cellar/nim/'
        if os.path.exists(base_dir):
            for version_dir in os.listdir(base_dir):
                nimbase_path = os.path.join(base_dir, version_dir, 'nim', 'lib', 'nimbase.h')
                if os.path.isfile(nimbase_path):
                    return nimbase_path

    return None  # nimbase.h not found
