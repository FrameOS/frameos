from flask import request, render_template
from . import app, db, tasks, models, socketio

@app.route('/logs/new', methods=['GET'])
def new_log():
    line = request.args.get('line')
    print(line)
    if line is not None:
        tasks.append_log_line(line)
        return 'Success', 200
    else:
        return 'No line provided', 400
    
@app.route('/')
def index():
    logs = models.Log.query.all()
    return render_template('index.html', logs=logs)
