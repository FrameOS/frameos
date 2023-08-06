from huey import crontab
from . import huey, db, models, socketio, app
from paramiko import RSAKey, SSHClient, AutoAddPolicy
from io import StringIO

def log(id: int, type: str, line: str) -> None:
    with app.app_context():
        frame_log = models.SSHLog(frame_id=id, line=line, type=type)
        db.session.add(frame_log)
        db.session.commit()
        socketio.emit('new_line', {'frame_id': id, 'line': line, 'type': type, 'timestamp': str(frame_log.timestamp)})


@huey.task()
def initialize_frame(id: int):
    with app.app_context():
        ssh = SSHClient()
        try:
            frame = models.Frame.query.get_or_404(id)
            log(id, "stdinfo", f"Connecting to {frame.ip}")
            ssh.set_missing_host_key_policy(AutoAddPolicy())

            # if ssh_key:
            with open('/Users/marius/.ssh/id_rsa', 'r') as f:
                ssh_key = f.read()
            ssh_key_obj = RSAKey.from_private_key(StringIO(ssh_key))

            split = frame.ip.split("@")
            host = split[0] if len(split) == 1 else split[1]
            user = split[0] if len(split) > 1 else "pi"
            ssh.connect(host, username=user, pkey=ssh_key_obj, timeout=10)
            # else:
            #     ssh.connect(frame.ip, username=ssh_user, password=ssh_pass, timeout=10)
            
            log(id, "stdinfo", f"Connected to {frame.ip}")
            
            # stdin, stdout, stderr = ssh.exec_command("df -h")
            stdin, stdout, stderr = ssh.exec_command("sudo apt upgrade -y")

            while line := stdout.readline(): #not stdout.channel.exit_status_ready():
                # line = stdout.readline()
                log(id, "stdout", line)
        except Exception as e:
            log(id, "stderr", str(e))
        finally:
            ssh.close()
            log(id, "stdinfo", "Connection closed")
