from asyncio import sleep
import atexit
import signal
import subprocess
from io import StringIO
from typing import Optional
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

from paramiko import RSAKey, SSHClient, AutoAddPolicy

from app.models.frame import Frame
from app.models.settings import Settings
from app.models.log import new_log as log
from sqlalchemy.orm import Session
from arq import ArqRedis as Redis

ssh_connections: set[SSHClient] = set()

def close_ssh_connections():
    for ssh in ssh_connections:
        try:
            ssh.close()
            print("SSH connection closed.")
        except:  # noqa: E722
            pass

atexit.register(close_ssh_connections)

def handle_signal(signum, frame):
    close_ssh_connections()
    exit(1)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

def remove_ssh_connection(ssh: SSHClient):
    ssh_connections.remove(ssh)

async def get_ssh_connection(db: Session, redis: Redis, frame: Frame) -> SSHClient:
    ssh_type = '(password)' if frame.ssh_pass else '(keypair)'
    await log(db, redis, frame.id, "stdinfo", f"Connecting via SSH to {frame.ssh_user}@{frame.frame_host} {ssh_type}")
    ssh = SSHClient()
    ssh_connections.add(ssh)
    ssh.set_missing_host_key_policy(AutoAddPolicy())

    if frame.ssh_pass:
        ssh.connect(frame.frame_host, username=frame.ssh_user, password=frame.ssh_pass, timeout=30)
    else:
        ssh_keys = db.query(Settings).filter_by(key="ssh_keys").first()
        default_key: Optional[str] = None
        if ssh_keys and ssh_keys.value:
            default_key = ssh_keys.value.get("default", None)
        if default_key:
            try:
                private_key_cryptography = load_pem_private_key(
                    default_key.encode(),
                    password=None,
                    backend=default_backend()
                )
                pem = private_key_cryptography.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.TraditionalOpenSSL,
                    encryption_algorithm=serialization.NoEncryption()
                )
                ssh_key_obj = RSAKey(file_obj=StringIO(pem.decode()))
            except:  # noqa: E722
                ssh_key_obj = RSAKey.from_private_key(StringIO(default_key))
            ssh.connect(frame.frame_host, username=frame.ssh_user, pkey=ssh_key_obj, timeout=30)
        else:
            raise Exception("Set up SSH keys in the settings page, or provide a password for the frame")
    await log(db, redis, int(frame.id), "stdinfo", f"Connected via SSH to {frame.ssh_user}@{frame.frame_host}")
    return ssh


async def exec_command(db: Session, redis: Redis, frame: Frame, ssh: SSHClient, command: str, output: Optional[list[str]] = None, raise_on_error = True, log_output = True) -> int:
    await log(db, redis, int(frame.id), "stdout", f"> {command}")
    _stdin, stdout, stderr = ssh.exec_command(command)
    exit_status = None
    while exit_status is None:
        while line := stdout.readline():
            if log_output:
                await log(db, redis, int(frame.id), "stdout", line)
            if output is not None:
                output.append(line)
        while line := stderr.readline():
            if log_output:
                await log(db, redis, int(frame.id), "stderr", line)
            if output is not None:
                output.append(line)

        # Check if the command has finished running
        if stdout.channel.exit_status_ready():
            exit_status = stdout.channel.recv_exit_status()

        # Sleep to prevent busy-waiting
        await sleep(0.1)

    if exit_status != 0:
        if raise_on_error:
            raise Exception(f"Command exited with status {exit_status}")
        else:
            await log(db, redis, int(frame.id), "exit_status", f"The command exited with status {exit_status}")

    return exit_status


async def exec_local_command(db: Session, redis: Redis, frame: Frame, command: str, generate_log = True) -> tuple[int, Optional[str], Optional[str]]:
    if generate_log:
        await log(db, redis, int(frame.id), "stdout", f"$ {command}")
    process = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    errors = []
    outputs = []
    break_next = False

    while True:
        if process.stdout:
            while output := process.stdout.readline():
                await log(db, redis, int(frame.id), "stdout", output)
                outputs.append(output)
        if process.stderr:
            while error := process.stderr.readline():
                await log(db, redis, int(frame.id), "stderr", error)
                errors.append(error)
        if break_next:
            break
        if process.poll() is not None:
            break_next = True
        await sleep(0.1)

    exit_status = process.returncode

    if exit_status != 0:
        await log(db, redis, int(frame.id), "exit_status", f"The command exited with status {exit_status}")

    return (exit_status, ''.join(outputs) if len(outputs) > 0 else None, ''.join(errors) if len(errors) > 0 else None)