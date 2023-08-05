from flask import request, render_template
from . import app, db, tasks, models, socketio

@app.route('/logs/new', methods=['GET'])
def new_log():
    tasks.initialize_frame()
    return 'Success', 200
    
@app.route('/')
def index():
    logs = models.SSHLog.query.all()
    # return render_template('index.html', logs=logs)
    return app.send_static_file('index.html')

@app.errorhandler(404)
def not_found(e):
    return app.send_static_file('index.html')
