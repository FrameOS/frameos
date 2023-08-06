from huey import crontab
from backend import huey, db, app
from backend.models import new_log as log, Frame, update_frame
from paramiko import RSAKey, SSHClient, AutoAddPolicy
from io import StringIO
from eventlet import sleep


@huey.task()
def initialize_frame(id: int):
    with app.app_context():
        ssh = SSHClient()
        try:
            frame = Frame.query.get_or_404(id)
            if frame.status != 'uninitialized':
                raise Exception(f"Frame status '{frame.status}', expected 'unitialized'")

            frame.status = 'initializing'
            update_frame(frame)

            log(id, "stdinfo", f"Connecting to {frame.ssh_user}@{frame.host}")
            ssh.set_missing_host_key_policy(AutoAddPolicy())

            if frame.ssh_pass:
                ssh.connect(frame.host, username=frame.ssh_user, password=frame.ssh_pass, timeout=10)
            else:
                with open('/Users/marius/.ssh/id_rsa', 'r') as f:
                    ssh_key = f.read()
                ssh_key_obj = RSAKey.from_private_key(StringIO(ssh_key))
                ssh.connect(frame.host, username=frame.ssh_user, pkey=ssh_key_obj, timeout=10)
            
            log(id, "stdinfo", f"Connected to {frame.ssh_user}@{frame.host}")

            stdin, stdout, stderr = ssh.exec_command("sudo apt upgrade -y")
                        
            exit_status = None
            while exit_status is None:
                while line := stdout.readline():
                    log(id, "stdout", line)
                while line := stderr.readline():
                    log(id, "stderr", line)
                    
                # Check if the command has finished running
                if stdout.channel.exit_status_ready():
                    exit_status = stdout.channel.recv_exit_status()

                # Sleep to prevent busy-waiting
                sleep(0.1)

            if exit_status != 0:
                log(id, "exit_status", f"The command exited with status {exit_status}")

            # Reset status so we can try again (TODO: make this work)
            frame.status = 'uninitialized'
            update_frame(frame)

        except Exception as e:
            log(id, "stderr", str(e))
            frame.status = 'uninitialized'
            update_frame(frame)
        finally:
            ssh.close()
            log(id, "stdinfo", "Connection closed")
