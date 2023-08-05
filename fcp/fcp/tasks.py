from huey import crontab
from . import huey, db, models, socketio, app
from paramiko import RSAKey, SSHClient, AutoAddPolicy
from io import StringIO

def log(type: str, line: str) -> None:
    with app.app_context():
        frame_log = models.SSHLog(frame_id=0, line=line, type=type)
        db.session.add(frame_log)
        db.session.commit()
        socketio.emit('new_line', {'line': line, 'type': type})


@huey.task()
def initialize_frame():
    with app.app_context():
        try:
            log("stdout", "Connecting to marius@devbox")

            ssh = SSHClient()
            ssh.set_missing_host_key_policy(AutoAddPolicy())

            # if ssh_key:
            with open('/Users/marius/.ssh/id_rsa', 'r') as f:
                ssh_key = f.read()
            ssh_key_obj = RSAKey.from_private_key(StringIO(ssh_key))
            ssh.connect("devbox", username="marius", pkey=ssh_key_obj, timeout=10)
            # else:
            #     ssh.connect(frame.ip, username=ssh_user, password=ssh_pass, timeout=10)
            
            log("stdout", "Connected to marius@devbox")
            
            stdin, stdout, stderr = ssh.exec_command("df -h")

            while line := stdout.readline(): #not stdout.channel.exit_status_ready():
                # line = stdout.readline()
                log("stdout", line)
        except Exception as e:
            log("stderr", str(e))
    
