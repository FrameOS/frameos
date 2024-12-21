from app.models.log import new_log as log
from app.models.frame import Frame, update_frame
from ..database import SessionLocal

async def reset_frame(id: int):
    with SessionLocal() as db:
        frame = db.get(Frame, id)
        if frame and frame.status != 'uninitialized':
            frame.status = 'uninitialized'
            await update_frame(db, frame)
        await log(db, id, "admin", "Resetting frame status to 'uninitialized'")
