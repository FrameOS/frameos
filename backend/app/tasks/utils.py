import os
from packaging import version
import subprocess
import platform
import hashlib

def get_nim_version(executable_path: str):
    try:
        result = subprocess.run([executable_path, '--version'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        output = result.stdout.split('\n')[0]
        version_str = output.split()[3]
        return version.parse(version_str)
    except Exception as e:
        print(f"Error getting Nim version: {e}")
        return None

def is_executable_in_path(executable: str):
    try:
        subprocess.run([executable, '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except FileNotFoundError:
        return False


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

    if is_executable_in_path('nim'):
        return 'nim'

    os_type = platform.system()
    for path in common_paths.get(os_type, []):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def find_nim_v2():
    nim_path = find_nim_executable()
    if not nim_path:
        raise Exception("Nim executable not found")
    nim_version = get_nim_version(nim_path)
    if not nim_version or nim_version < version.parse("2.0.0"):
        raise Exception("Nim 2.0.0 or higher is required")
    return nim_path


def find_nimbase_file(nim_executable: str):
    nimbase_paths: list[str] = []

    try:
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

    for path in nimbase_paths:
        nb_file = os.path.join(path, 'nimbase.h')
        if os.path.isfile(nb_file):
            return nb_file

    if os_type == 'Darwin':
        base_dir = '/opt/homebrew/Cellar/nim/'
        if os.path.exists(base_dir):
            for verdir in os.listdir(base_dir):
                nb_file = os.path.join(base_dir, verdir, 'nim', 'lib', 'nimbase.h')
                if os.path.isfile(nb_file):
                    return nb_file
    return None


def compile_line_md5(input_str: str) -> str:
    words = []
    ignore_next = False
    for word in input_str.split(' '):
        if word == '-I':
            ignore_next = True
        elif ignore_next or word.startswith("-I"):
            pass
        else:
            words.append(word)
    return hashlib.md5(" ".join(words).encode()).hexdigest()

