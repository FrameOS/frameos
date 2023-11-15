import json

from io import StringIO
from scp import SCPClient

from app import huey, app
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame, get_frame_json
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

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
            remove_ssh_connection(ssh)
