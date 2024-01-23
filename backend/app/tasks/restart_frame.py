

from app import create_app
from app.huey import huey
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection

@huey.task()
def restart_frame(id: int):
    app = create_app()
    with app.app_context():
        ssh = None
        try:
            frame = Frame.query.get_or_404(id)

            frame.status = 'restarting'
            update_frame(frame)

            ssh = get_ssh_connection(frame)
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
