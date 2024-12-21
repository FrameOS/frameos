from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from app.redis import get_redis
from ..database import SessionLocal

async def reset_frame(id: int):
    with SessionLocal() as db, get_redis() as redis:
        frame = db.get(Frame, id)
        if frame and frame.status != 'uninitialized':
            frame.status = 'uninitialized'
            await update_frame(db, redis, frame)
        await log(db, redis, id, "admin", "Resetting frame status to 'uninitialized'")
