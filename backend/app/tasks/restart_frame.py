from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.utils.ssh_utils import get_ssh_connection, exec_command, remove_ssh_connection
from app.database import SessionLocal
from app.redis import get_redis

async def restart_frame(id: int):
    with SessionLocal() as db, get_redis() as redis:
        ssh = None
        frame = None
        try:
            frame = db.get(Frame, id)
            if not frame:
                await log(db, id, "stderr", "Frame not found")
                return

            frame.status = 'restarting'
            await update_frame(db, redis, frame)

            ssh = await get_ssh_connection(db, frame)
            await exec_command(db, frame, ssh, "sudo systemctl stop frameos.service || true")
            await exec_command(db, frame, ssh, "sudo systemctl enable frameos.service")
            await exec_command(db, frame, ssh, "sudo systemctl start frameos.service")
            await exec_command(db, frame, ssh, "sudo systemctl status frameos.service")

            frame.status = 'starting'
            await update_frame(db, redis, frame)

        except Exception as e:
            await log(db, id, "stderr", str(e))
            if frame:
                frame.status = 'uninitialized'
                await update_frame(db, redis, frame)
        finally:
            if ssh is not None:
                ssh.close()
                await log(db, id, "stdinfo", "SSH connection closed")
                remove_ssh_connection(ssh)
