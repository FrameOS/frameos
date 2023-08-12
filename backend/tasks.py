import json
from backend import huey, app
from backend.models import new_log as log, Frame, update_frame
from paramiko import RSAKey, SSHClient, AutoAddPolicy
from io import StringIO
from gevent import sleep
from scp import SCPClient
import atexit
import signal
from huey.signals import SIGNAL_ERROR, SIGNAL_LOCKED

@huey.signal(SIGNAL_LOCKED)
def task_not_run_handler(signal, task, exc=None):
    # Do something in response to the "ERROR" or "LOCEKD" signals.
    # Note that the "ERROR" signal includes a third parameter,
    # which is the unhandled exception that was raised by the task.
    # Since this parameter is not sent with the "LOCKED" signal, we
    # provide a default of ``exc=None``.
    print('SIGNAL_ERROR')
    print(SIGNAL_ERROR)

@huey.signal(SIGNAL_LOCKED)
def task_not_run_handler(signal, task, exc=None):
    print('SIGNAL_LOCKED')
    print(SIGNAL_LOCKED)

ssh_connections = set()

def close_ssh_connection():
    for ssh in ssh_connections:
        try:
            ssh.close()
            print("SSH connection closed.")
        except:
            pass

# Registering the close_ssh_connection function to be called on exit
atexit.register(close_ssh_connection)

# You may also catch specific signals to handle them
def handle_signal(signum, frame):
    close_ssh_connection()
    exit(1)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

@huey.task()
def reset_frame(id: int):
    with app.app_context():
        frame = Frame.query.get_or_404(id)
        if frame.status != 'uninitialized':
            frame.status = 'uninitialized'
            update_frame(frame)
        log(id, "admin", "Resetting frame status to 'uninitialized'")

def get_ssh_connection(frame: Frame) -> SSHClient:
    ssh = SSHClient()
    ssh_connections.add(ssh)
    ssh.set_missing_host_key_policy(AutoAddPolicy())

    if frame.ssh_pass:
        ssh.connect(frame.frame_host, username=frame.ssh_user, password=frame.ssh_pass, timeout=10)
    else:
        with open('/Users/marius/.ssh/id_rsa', 'r') as f:
            ssh_key = f.read()
        ssh_key_obj = RSAKey.from_private_key(StringIO(ssh_key))
        ssh.connect(frame.frame_host, username=frame.ssh_user, pkey=ssh_key_obj, timeout=10)
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

def get_frame_json(frame: Frame) -> dict:
    frame_json = frame.to_dict()
    frame_json.pop("frame_host", None)
    frame_json.pop("frame_port", None)
    frame_json.pop("ssh_user", None)
    frame_json.pop("ssh_pass", None)
    frame_json.pop("ssh_port", None)
    frame_json.pop("status", None)
    return frame_json


@huey.task()
def initialize_frame(id: int):
    with app.app_context():
        try:
            frame = Frame.query.get_or_404(id)
            if frame.status == 'deploying':
                raise Exception(f"Can not deploy while already deploying")

            frame.status = 'deploying'
            update_frame(frame)

            log(id, "stdinfo", f"Connecting to {frame.ssh_user}@{frame.frame_host}")
            ssh = get_ssh_connection(frame)                
            log(id, "stdinfo", f"Connected to {frame.ssh_user}@{frame.frame_host}")

            # exec_command(frame, ssh, "sudo apt -y install libopenjp2-7")
            exec_command(frame, ssh, "dpkg -l | grep -q \"^ii  libopenjp2-7\" || sudo apt -y install libopenjp2-7")
            exec_command(frame, ssh, "sudo mkdir -p /srv/frameos")
            exec_command(frame, ssh, f"sudo chown -R {frame.ssh_user} /srv/frameos")

            with SCPClient(ssh.get_transport()) as scp:
                log(id, "stdout", "> add /srv/frameos/frame.json")
                scp.putfo(StringIO(json.dumps(get_frame_json(frame), indent=4) + "\n"), "/srv/frameos/frame.json")
                
                log(id, "stdout", "> add /srv/frameos/frame.py")
                scp.put("./device/frame.py", "/srv/frameos/frame.py")
                
                log(id, "stdout", "> add /srv/frameos/index.html")
                scp.put("./device/index.html", "/srv/frameos/index.html")
                
                log(id, "stdout", "> add /srv/frameos/requirements.txt")
                scp.put("./device/requirements.txt", "/srv/frameos/requirements.txt")

            exec_command(frame, ssh, "cd /srv/frameos && (sha256sum -c requirements.txt.sha256sum 2>/dev/null || (pip3 install -r requirements.txt && sha256sum requirements.txt > requirements.txt.sha256sum))")

            exec_command(frame, ssh, "tmux has-session -t frameos 2>/dev/null && tmux kill-session -t frameos")
            exec_command(frame, ssh, "cd /srv/frameos && tmux new-session -s frameos -d 'python3 frame.py'")

            frame.status = 'starting'
            update_frame(frame)

        except Exception as e:
            log(id, "stderr", str(e))
            frame.status = 'uninitialized'
            update_frame(frame)
        finally:
            ssh.close()
            ssh_connections.remove(ssh)
            log(id, "stdinfo", "Connection closed")

@huey.task()
def restart_frame(id: int):
    with app.app_context():
        ssh = None
        try:
            frame = Frame.query.get_or_404(id)

            frame.status = 'restarting'
            update_frame(frame)

            log(id, "stdinfo", f"Connecting to {frame.ssh_user}@{frame.frame_host}")
            ssh = get_ssh_connection(frame)                
            log(id, "stdinfo", f"Connected to {frame.ssh_user}@{frame.frame_host}")

            log(id, "stdout", "> add /srv/frameos/frame.json")
            with SCPClient(ssh.get_transport()) as scp:
                scp.putfo(StringIO(json.dumps(get_frame_json(frame), indent=4) + "\n"), "/srv/frameos/frame.json")
            exec_command(frame, ssh, "tmux has-session -t frameos 2>/dev/null && tmux kill-session -t frameos")
            exec_command(frame, ssh, "cd /srv/frameos && tmux new-session -s frameos -d 'python3 frame.py'")

            frame.status = 'starting'
            update_frame(frame)

        except Exception as e:
            log(id, "stderr", str(e))
            frame.status = 'uninitialized'
            update_frame(frame)
        finally:
            if ssh is not None:
                ssh.close()
            ssh_connections.remove(ssh)
            log(id, "stdinfo", "Connection closed")
