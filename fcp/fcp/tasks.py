from huey import crontab
from . import huey, db, models, socketio, app

@huey.task()
def append_log_line(line):
    with app.app_context():  # push an application context
        log = models.Log(line=line)
        db.session.add(log)
        db.session.commit()
        socketio.emit('new_line', {'line': line})
