from app import huey, app
from app.models.log import new_log as log
from app.models.frame import Frame, update_frame


@huey.task()
def reset_frame(id: int):
    with app.app_context():
        frame = Frame.query.get_or_404(id)
        if frame.status != 'uninitialized':
            frame.status = 'uninitialized'
            update_frame(frame)
        log(id, "admin", "Resetting frame status to 'uninitialized'")
