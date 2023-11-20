import io
import json
import os

from zipfile import ZipFile
from io import StringIO

from scp import SCPClient

from app import huey, create_app
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.models.apps import get_apps_from_scenes
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

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
            exec_command(frame, ssh, 'command -v raspi-config > /dev/null && sudo raspi-config nonint get_i2c | grep -q "1" && { sudo raspi-config nonint do_i2c 0; echo "I2C is now enabled"; }')
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
                remove_ssh_connection(ssh)
