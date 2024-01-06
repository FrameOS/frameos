import json
import hashlib
import os
import random
import re
import shutil
import string
import subprocess
import tempfile

from packaging import version

import platform

from io import StringIO

from scp import SCPClient

from app import create_app
from app.codegen.drivers_nim import write_drivers_nim
from app.codegen.scene_nim import write_scene_nim
from app.drivers.devices import drivers_for_device
from app.drivers.waveshare import write_waveshare_driver_nim
from app.huey import huey
from app.models import get_apps_from_scenes
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection, exec_local_command


@huey.task()
def deploy_frame(id: int):
    app = create_app()
    with app.app_context():
        ssh = None
        try:
            frame = Frame.query.get_or_404(id)
            if frame.status == 'deploying':
                raise Exception(f"Already deploying, will not deploy again. Request again to force deploy.")

            frame.status = 'deploying'
            update_frame(frame)

            # TODO: add the concept of builds into the backend (track each build in the database)
            build_id = ''.join(random.choice(string.ascii_lowercase) for i in range(12))
            log(id, "stdout", f"Deploying frame {frame.name} with build id {build_id}")

            nim_path = find_nim_v2()
            ssh = get_ssh_connection(frame)

            def install_if_necessary(package: str):
                """If a package is not installed, install it."""
                exec_command(frame, ssh, f"dpkg -l | grep -q \"^ii  {package}\" || sudo apt-get install -y {package}")

            with tempfile.TemporaryDirectory() as temp_dir:
                log(id, "stdout", f"- Getting target architecture")
                uname_output = []
                exec_command(frame, ssh, f"uname -m", uname_output)
                arch = "".join(uname_output).strip()
                if arch == "aarch64" or arch == "armv7l":
                    cpu = "arm64"
                elif arch == "armv6l":
                    cpu = "arm"
                elif arch == "i386":
                    cpu = "i386"
                else:
                    cpu = "amd64"

                drivers = drivers_for_device(frame.device)

                # create a build .tar.gz
                log(id, "stdout", f"- Copying build folders")
                build_dir, source_dir = create_build_folders(temp_dir, build_id)
                log(id, "stdout", f"- Applying local modifications")
                make_local_modifications(frame, source_dir)
                log(id, "stdout", f"- Creating build archive")
                archive_path = create_local_build_archive(frame, build_dir, build_id, nim_path, source_dir, temp_dir, cpu)

                with SCPClient(ssh.get_transport()) as scp:
                    # build the release on the server
                    install_if_necessary("ntp")
                    install_if_necessary("build-essential")
                    if drivers.get("evdev"):
                        install_if_necessary("libevdev-dev")
                    if drivers.get('waveshare'):
                        install_if_necessary("libgpiod-dev")

                    exec_command(frame, ssh, "if [ ! -d /srv/frameos/ ]; then sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; fi")
                    exec_command(frame, ssh, f"mkdir -p /srv/frameos/build/")
                    log(id, "stdout", f"> add /srv/frameos/build/build_{build_id}.tar.gz")
                    scp.put(archive_path, f"/srv/frameos/build/build_{build_id}.tar.gz")
                    exec_command(frame, ssh, f"cd /srv/frameos/build && tar -xzf build_{build_id}.tar.gz && rm build_{build_id}.tar.gz")
                    exec_command(frame, ssh, f"cd /srv/frameos/build/build_{build_id} && sh ./compile_frameos.sh")
                    exec_command(frame, ssh, f"mkdir -p /srv/frameos/releases/release_{build_id}")
                    exec_command(frame, ssh, f"cp /srv/frameos/build/build_{build_id}/frameos /srv/frameos/releases/release_{build_id}/frameos")
                    log(id, "stdout", f"> add /srv/frameos/releases/release_{build_id}/frame.json")
                    scp.putfo(StringIO(json.dumps(get_frame_json(frame), indent=4) + "\n"), f"/srv/frameos/releases/release_{build_id}/frame.json")

                    # TODO: abstract driver-specific install steps
                    # TODO: abstract vendor logic
                    if inkyPython := drivers.get("inkyPython"):
                        exec_command(frame, ssh, f"cp -r /srv/frameos/build/build_{build_id}/vendor /srv/frameos/releases/release_{build_id}/vendor")
                        install_if_necessary("python3-pip")
                        install_if_necessary("python3-venv")
                        exec_command(frame, ssh, f"cd /srv/frameos/releases/release_{build_id}/vendor/{inkyPython.vendor_folder} && python3 -m venv env && env/bin/pip3 install -r requirements.txt")

                    if inkyHyperPixel2r := drivers.get("inkyHyperPixel2r"):
                        exec_command(frame, ssh, f"cp -r /srv/frameos/build/build_{build_id}/vendor /srv/frameos/releases/release_{build_id}/vendor")
                        install_if_necessary("python3-pip")
                        install_if_necessary("python3-venv")
                        exec_command(frame, ssh, f"cd /srv/frameos/releases/release_{build_id}/vendor/{inkyHyperPixel2r.vendor_folder} && python3 -m venv env && env/bin/pip3 install -r requirements.txt")

                    # add frameos.service
                    with open("../frameos/frameos.service", "r") as file:
                        service_contents = file.read().replace("%I", frame.ssh_user)
                    with SCPClient(ssh.get_transport()) as scp:
                        scp.putfo(StringIO(service_contents), f"/srv/frameos/releases/release_{build_id}/frameos.service")
                    exec_command(frame, ssh, f"sudo cp /srv/frameos/releases/release_{build_id}/frameos.service /etc/systemd/system/frameos.service")
                    exec_command(frame, ssh, "sudo chown root:root /etc/systemd/system/frameos.service")
                    exec_command(frame, ssh, "sudo chmod 644 /etc/systemd/system/frameos.service")

                # swap out the release
                exec_command(frame, ssh, f"rm -rf /srv/frameos/current && ln -s /srv/frameos/releases/release_{build_id} /srv/frameos/current")

                # restart
                exec_command(frame, ssh, "sudo systemctl daemon-reload")
                exec_command(frame, ssh, "sudo systemctl enable frameos.service")
                exec_command(frame, ssh, "sudo systemctl restart frameos.service")
                exec_command(frame, ssh, "sudo systemctl status frameos.service")

            if drivers.get("i2c"):
                exec_command(frame, ssh, 'grep -q "^dtparam=i2c_vc=on$" /boot/config.txt || echo "dtparam=i2c_vc=on" | sudo tee -a /boot/config.txt')
                exec_command(frame, ssh, 'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1" && { sudo raspi-config nonint do_i2c 0; echo "I2C is now enabled"; }')

            if drivers.get("spi"):
                exec_command(frame, ssh, 'sudo raspi-config nonint do_spi 0')

            frame.status = 'starting'
            update_frame(frame)

        except Exception as e:
            log(id, "stderr", str(e))
            frame.status = 'uninitialized'
            update_frame(frame)
        finally:
            if ssh is not None:
                ssh.close()
                log(frame.id, "stdinfo", "SSH connection closed")
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


def make_local_modifications(frame: Frame, source_dir: str):
    shutil.rmtree(os.path.join(source_dir, "src", "scenes"), ignore_errors=True)
    os.makedirs(os.path.join(source_dir, "src", "scenes"), exist_ok=True)

    # write all source apps
    for node_id, sources in get_apps_from_scenes(frame.scenes).items():
        app_id = "nodeapp_" + node_id.replace('-', '_')
        app_dir = os.path.join(source_dir, "src", "apps", app_id)
        os.makedirs(app_dir, exist_ok=True)
        for file, source in sources.items():
            with open(os.path.join(app_dir, file), "w") as file:
                file.write(source)

    # only one scene called "default" for now
    for scene in frame.scenes:
        scene_source = write_scene_nim(frame, scene)
        with open(os.path.join(source_dir, "src", "scenes", f"{scene.get('id')}.nim"), "w") as file:
            file.write(scene_source)

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

def create_local_build_archive(frame: Frame, build_dir: str, build_id: str, nim_path: str, source_dir: str, temp_dir: str, cpu: str):
    # TODO: abstract driver-specific vendor steps
    drivers = drivers_for_device(frame.device)
    if inkyPython := drivers.get('inkyPython'):
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        shutil.copytree(f"../frameos/vendor/{inkyPython.vendor_folder}/", os.path.join(build_dir, "vendor", inkyPython.vendor_folder), dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", inkyPython.vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", inkyPython.vendor_folder, "__pycache__"), ignore_errors=True)
    if inkyHyperPixel2r := drivers.get('inkyHyperPixel2r'):
        os.makedirs(os.path.join(build_dir, "vendor"), exist_ok=True)
        shutil.copytree(f"../frameos/vendor/{inkyHyperPixel2r.vendor_folder}/", os.path.join(build_dir, "vendor", inkyHyperPixel2r.vendor_folder), dirs_exist_ok=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", inkyHyperPixel2r.vendor_folder, "env"), ignore_errors=True)
        shutil.rmtree(os.path.join(build_dir, "vendor", inkyHyperPixel2r.vendor_folder, "__pycache__"), ignore_errors=True)

    # Tell a white lie
    log(frame.id, "stdout", f"- No cross compilation. Generating source code for compilation on frame.")

    # run "nim c --os:linux --cpu:arm64 --compileOnly --genScript --nimcache:tmp/build_1 src/frameos.nim"
    status, out, err = exec_local_command(
        frame,
        f"cd {source_dir} && nimble assets -y && {nim_path} compile --os:linux --cpu:{cpu} --compileOnly --genScript --nimcache:{build_dir} src/frameos.nim 2>&1"
    )
    if status != 0:
        last_line = [line for line in err.split("\n") if line != ''][-1]
        if match := re.match(r'^(.*\.nim)\((\d+), (\d+)\),*', last_line):
            filename = match.group(1)
            line = int(match.group(2))
            column = int(match.group(3))
            source_path = os.path.realpath(source_dir)
            final_path = os.path.realpath(os.path.join(source_dir, filename))
            if os.path.commonprefix([final_path, source_path]) == source_path:
                filename = final_path[len(source_path) + 1:]
                with open(final_path, "r") as file:
                    lines = file.readlines()
                log(frame.id, "stdout", f"Error in {filename}:{line}:{column}")
                log(frame.id, "stdout", f"Line {line}: {lines[line - 1]}")
                log(frame.id, "stdout", f".......{'.' * (column - 1 + len(str(line)))}^")
            else:
                log(frame.id, "stdout", f"Error in {filename}:{line}:{column}")

        raise Exception("Failed to generate frameos sources")

    # Copy the file "nimbase.h" to "build_1/nimbase.h"
    nimbase_path = find_nimbase_file(nim_path)
    if not nimbase_path:
        raise Exception("nimbase.h not found")
    shutil.copy(nimbase_path, os.path.join(build_dir, "nimbase.h"))

    if waveshare := drivers.get('waveshare'):
        files = [
            "Debug.h", "DEV_Config.c", "DEV_Config.h", "RPI_gpiod.c", "RPI_gpiod.h", "dev_hardware_SPI.c", "dev_hardware_SPI.h",
        ]
        for file in files:
            shutil.copy(os.path.join(source_dir, "src", "drivers", "waveshare", "ePaper", file), os.path.join(build_dir, file))

        if waveshare.variant:
            files = [f"{waveshare.variant}.nim", f"{waveshare.variant}.c", f"{waveshare.variant}.h"]
            for file in files:
                shutil.copy(os.path.join(source_dir, "src", "drivers", "waveshare", "ePaper", file), os.path.join(build_dir, file))

    # Update the compilation script for verbose output
    script_path = os.path.join(build_dir, "compile_frameos.sh")
    log(frame.id, "stdout", f"Cleaning build script at {script_path}")
    with open(script_path, "r") as file:
        lines = file.readlines()
    with open(script_path, "w") as file:
        file.write("#!/bin/sh\n")
        file.write("set -eu\n")
        file.write("start_time=$(date +%s)\n")
        file.write("mkdir -p ../cache\n") # make sure we have the cache folder
        file.write("cached_files_count=0\n")  # Initialize cached files counter
        for i, line in enumerate(lines):
            if line.startswith("gcc -c") and line.strip().endswith(".c"):
                source_file = line.split(' ')[-1].strip()
                o_file = line.split(' ')[-2].strip()
                source_cleaned = '/'.join(source_file.split('@s')[-3:]).replace('@m', './')

                # take the md5sum of the source file <source>.c
                file.write(f"md5sum={compile_line_md5(line)}$(md5sum {source_file} | awk '{{print $1}}')\n")
                # check if there's a file in the cache folder called <md5sum>.c.o
                file.write(f"if [ -f ../cache/${{md5sum}}.{cpu}.c.o ]; then\n")
                # if there is, make a symlink to the build folder with the name <source>.o
                file.write(f"    cached_files_count=$((cached_files_count + 1))\n")
                file.write(f"    ln -s ../cache/${{md5sum}}.{cpu}.c.o {o_file}\n")
                file.write("else\n")
                # if not, run the command in "line" and then copy the <source>.c.o into the build folder as <md5sum>.c.o
                file.write(f"    echo [{i + 1}/{len(lines)}] Compiling on device: {source_cleaned}\n")
                file.write(f"    {line.strip()}\n")
                file.write(f"    cp {o_file} ../cache/${{md5sum}}.{cpu}.c.o\n")
                file.write("fi\n")
            else:
                file.write(f"echo [{i + 1}/{len(lines)}] Compiling on device: frameos\n")
                file.write(line)
        file.write("echo \"Used $cached_files_count cached files\"\n")
        file.write("end_time=$(date +%s)\n")
        file.write("duration=$((end_time - start_time))\n")
        file.write("echo \"Compiled in $duration seconds\"\n")

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
    nimbase_paths = []

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
