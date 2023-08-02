from celery import shared_task
from flask_socketio import emit
from app.models import Frame, FrameLog
from paramiko import SSHClient
from app import db

@shared_task(ignore_result=False)
def initialize_frame(id: int) -> None:
    frame = Frame.query.get(id)

    ssh = SSHClient()
    ssh.connect(hostname=frame.ip, username='pi', password='raspberry')
    stdin, stdout, stderr = ssh.exec_command("while true; do uptime; done")

    def line_buffered(f):
        line_buf = ""
        while not f.channel.exit_status_ready():
            line_buf += f.read(1)
            if line_buf.endswith('\n'):
                yield line_buf
                line_buf = ''

    for line in line_buffered(stdout):
        print(line)
        emit('log_updated', {'line': line})
        frame_log = FrameLog(frame_id=id, line=line, type='stdout')
        db.session.add(frame_log)
        db.session.commit()