import io
import json
import os
from zipfile import ZipFile

from app import huey, app
from app.models import new_log as log, Frame, update_frame, get_apps_from_scenes, get_settings_dict, get_app_configs, \
    Settings
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

def get_frame_json(frame: Frame) -> dict:
    frame_json = frame.to_dict()
    frame_json.pop("frame_host", None)
    frame_json.pop("frame_port", None)
    frame_json.pop("ssh_user", None)
    frame_json.pop("ssh_pass", None)
    frame_json.pop("ssh_port", None)
    frame_json.pop("status", None)

    setting_keys = set()
    app_configs = get_app_configs()
    for scene in frame.scenes:
        for node in scene.get('nodes', []):
            if node.get('type', None) == 'app':
                sources = node.get('data', {}).get('sources', None)
                if sources and len(sources) > 0:
                    try:
                        config = sources.get('config.json', '{}')
                        config = json.loads(config)
                        settings = config.get('settings', [])
                        for key in settings:
                            setting_keys.add(key)
                    except:
                        pass
                else:
                    keyword = node.get('data', {}).get('keyword', None)
                    if keyword:
                        app_config = app_configs.get(keyword, None)
                        if app_config:
                            settings = app_config.get('settings', [])
                            for key in settings:
                                setting_keys.add(key)

    all_settings = get_settings_dict()
    final_settings = {}
    for key in setting_keys:
        final_settings[key] = all_settings.get(key, None)

    frame_dsn = all_settings.get('sentry', {}).get('frame_dsn', None)
    final_settings['sentry'] = { 'frame_dsn': frame_dsn }

    frame_json['settings'] = final_settings
    return frame_json


@huey.task()
def deploy_frame(id: int):
    with app.app_context():
        ssh = None
        try:
            frame = Frame.query.get_or_404(id)
            if frame.status == 'deploying':
                raise Exception(f"Already deploying, will not deploy again. Request again to force deploy.")

            frame.status = 'deploying'
            update_frame(frame)

            ssh = get_ssh_connection(frame)                

            # exec_command(frame, ssh, "sudo apt -y update")
            exec_command(frame, ssh, "dpkg -l | grep -q \"^ii  libopenjp2-7\" || sudo apt -y install libopenjp2-7")
            exec_command(frame, ssh, "dpkg -l | grep -q \"^ii  libopenblas-dev\" || sudo apt -y install libopenblas-dev")
            exec_command(frame, ssh, "dpkg -l | grep -q \"^ii  python3-pip\" || sudo apt -y install python3-pip")
            exec_command(frame, ssh, "dpkg -l | grep -q \"^ii  fonts-dejavu\" || sudo apt -y install fonts-dejavu")

            exec_command(frame, ssh, 'version=$(python3 --version 2>&1) && [[ $version == *" 3.11"* ]] && echo Currently using: $version || '
                                     'echo "WARNING! FrameOS is built for Python 3.11. You\'re running $version. This may cause issues."')

            # enable i2c
            exec_command(frame, ssh, 'grep -q "^dtparam=i2c_vc=on$" /boot/config.txt || echo "dtparam=i2c_vc=on" | sudo tee -a /boot/config.txt')
            # enable spi
            exec_command(frame, ssh, 'sudo raspi-config nonint do_spi 0')

            exec_command(frame, ssh, "sudo mkdir -p /srv/frameos")
            exec_command(frame, ssh, f"sudo chown -R {frame.ssh_user} /srv/frameos")

            with SCPClient(ssh.get_transport()) as scp:
                log(id, "stdout", "> add /srv/frameos/frame.json")
                scp.putfo(StringIO(json.dumps(get_frame_json(frame), indent=4) + "\n"), "/srv/frameos/frame.json")
                
                log(id, "stdout", "> add /srv/frameos/run.py")
                scp.put("../frameos/run.py", "/srv/frameos/run.py")

                log(id, "stdout", "> add /srv/frameos/version.py")
                scp.put("../frameos/version.py", "/srv/frameos/version.py")

                log(id, "stdout", "> add /srv/frameos/frame/*")
                scp.put("../frameos/frame", "/srv/frameos/", recursive=True)

                log(id, "stdout", "> add /srv/frameos/apps/*")
                scp.put("../frameos/apps", "/srv/frameos/", recursive=True)

                for node_id, sources in get_apps_from_scenes(frame.scenes).items():
                    app_id = "node_" + node_id.replace('-', '_')
                    log(id, "stdout", f"> add /srv/frameos/apps/{app_id}.zip")
                    zip_archive = io.BytesIO()
                    with ZipFile(zip_archive, "w") as new_archive:
                        for file, source in sources.items():
                            new_archive.writestr(os.path.join(file), source.encode())
                    zip_archive.seek(0)
                    scp.putfo(zip_archive, f"/srv/frameos/apps/{app_id}.zip")

                if 'waveshare.' in frame.device:
                    log(id, "stdout", "> add /srv/frameos/lib/*")
                    scp.put("../frameos/lib", "/srv/frameos/", recursive=True)

                log(id, "stdout", "> add /srv/frameos/index.html")
                scp.put("../frameos/index.html", "/srv/frameos/index.html")
                
                log(id, "stdout", "> add /srv/frameos/requirements.txt")
                scp.put("../frameos/requirements.txt", "/srv/frameos/requirements.txt")
                
                with open("../frameos/frameos.service", "r") as file:
                    service_contents = file.read().replace("%I", frame.ssh_user)
                    print(service_contents)
                with SCPClient(ssh.get_transport()) as scp:
                    scp.putfo(StringIO(service_contents), "/srv/frameos/frameos.service")

            # Move service file to the appropriate location and set permissions
            exec_command(frame, ssh, "sudo mv /srv/frameos/frameos.service /etc/systemd/system/frameos.service")
            exec_command(frame, ssh, "sudo chown root:root /etc/systemd/system/frameos.service")
            exec_command(frame, ssh, "sudo chmod 644 /etc/systemd/system/frameos.service")
            exec_command(frame, ssh, "sudo rm -rf /usr/lib/python3.11/EXTERNALLY-MANAGED")
            exec_command(frame, ssh, "cd /srv/frameos && (sha256sum -c requirements.txt.sha256sum 2>/dev/null || (echo '> pip3 install -r requirements.txt' && pip3 install -r requirements.txt && sha256sum requirements.txt > requirements.txt.sha256sum))")

            # Reload systemd, stop any existing service, enable and restart the new service
            exec_command(frame, ssh, "sudo systemctl daemon-reload")
            exec_command(frame, ssh, "sudo systemctl stop frameos.service || true")
            exec_command(frame, ssh, "sudo systemctl enable frameos.service")
            exec_command(frame, ssh, "sudo systemctl start frameos.service")
            exec_command(frame, ssh, "sudo systemctl status frameos.service")

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
                ssh_connections.remove(ssh)

@huey.task()
def restart_frame(id: int):
    with app.app_context():
        ssh = None
        try:
            frame = Frame.query.get_or_404(id)

            frame.status = 'restarting'
            update_frame(frame)

            ssh = get_ssh_connection(frame)                

            log(id, "stdout", "> add /srv/frameos/frame.json")
            with SCPClient(ssh.get_transport()) as scp:
                scp.putfo(StringIO(json.dumps(get_frame_json(frame), indent=4) + "\n"), "/srv/frameos/frame.json")

            exec_command(frame, ssh, "sudo systemctl stop frameos.service || true")
            exec_command(frame, ssh, "sudo systemctl enable frameos.service")
            exec_command(frame, ssh, "sudo systemctl start frameos.service")
            exec_command(frame, ssh, "sudo systemctl status frameos.service")

            frame.status = 'starting'
            update_frame(frame)

        except Exception as e:
            log(id, "stderr", str(e))
            frame.status = 'uninitialized'
            update_frame(frame)
        finally:
            if ssh is not None:
                ssh.close()
                log(id, "stdinfo", "SSH connection closed")
            ssh_connections.remove(ssh)
