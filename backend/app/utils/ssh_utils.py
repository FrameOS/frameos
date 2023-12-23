import atexit
import signal
import subprocess
from io import StringIO
from typing import Optional

from paramiko import RSAKey, SSHClient, AutoAddPolicy
from gevent import sleep

from app.models.frame import Frame
from app.models.settings import Settings
from app.models.log import new_log as log

ssh_connections = set()

def close_ssh_connections():
    for ssh in ssh_connections:
        try:
            ssh.close()
            print("SSH connection closed.")
        except:
            pass

atexit.register(close_ssh_connections)

def handle_signal(signum, frame):
    close_ssh_connections()
    exit(1)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

def remove_ssh_connection(ssh: SSHClient):
    ssh_connections.remove(ssh)

def get_ssh_connection(frame: Frame) -> SSHClient:
    ssh_type = '(password)' if frame.ssh_pass else '(keypair)'
    log(frame.id, "stdinfo", f"Connecting via SSH to {frame.ssh_user}@{frame.frame_host} {ssh_type}")
    ssh = SSHClient()
    ssh_connections.add(ssh)
    ssh.set_missing_host_key_policy(AutoAddPolicy())

    if frame.ssh_pass:
        ssh.connect(frame.frame_host, username=frame.ssh_user, password=frame.ssh_pass, timeout=10)
    else:
        ssh_keys = Settings.query.filter_by(key="ssh_keys").first()
        default_key = None
        if ssh_keys and ssh_keys.value:
            default_key = ssh_keys.value.get("default", None)
        if default_key:
            ssh_key_obj = RSAKey.from_private_key(StringIO(default_key))
            ssh.connect(frame.frame_host, username=frame.ssh_user, pkey=ssh_key_obj, timeout=10)
        else:
            raise Exception(f"Set up SSH keys in the settings page, or provide a password for the frame")
    log(frame.id, "stdinfo", f"Connected via SSH to {frame.ssh_user}@{frame.frame_host}")
    return ssh


def exec_command(frame: Frame, ssh: SSHClient, command: str) -> int:
    log(frame.id, "stdout", f"> {command}")
    _stdin, stdout, stderr = ssh.exec_command(command)
    exit_status = None
    while exit_status is None:
        while line := stdout.readline():
            log(frame.id, "stdout", line)
        while line := stderr.readline():
            log(frame.id, "stderr", line)

        # Check if the command has finished running
        if stdout.channel.exit_status_ready():
            exit_status = stdout.channel.recv_exit_status()

        # Sleep to prevent busy-waiting
        sleep(0.1)

    if exit_status != 0:
        log(frame.id, "exit_status", f"The command exited with status {exit_status}")

    return exit_status


def exec_local_command(frame: Frame, command: str, generate_log = True) -> (int, Optional[str], Optional[str]):
    if generate_log:
        log(frame.id, "stdout", f"-> {command}")
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    errors = []
    outputs = []
    break_next = False

    while True:
        while output := process.stdout.readline():
            log(frame.id, "stdout", output)
            outputs.append(output)
        while error := process.stderr.readline():
            log(frame.id, "stderr", error)
            errors.append(error)
        if break_next:
            break
        if process.poll() is not None:
            break_next = True
        sleep(0.1)

    exit_status = process.returncode

    if exit_status != 0:
        log(frame.id, "exit_status", f"The command exited with status {exit_status}")

    return (exit_status, ''.join(outputs) if len(outputs) > 0 else None, ''.join(errors) if len(errors) > 0 else None)