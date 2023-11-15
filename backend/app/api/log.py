from flask import request
from app import app
from app.models.frame import Frame
from app.models.log import process_log

@app.route('/api/log', methods=["POST"])
def api_log():
    auth_header = request.headers.get('Authorization')
    server_api_key = auth_header.split(' ')[1]
    frame = Frame.query.filter_by(server_api_key=server_api_key).first_or_404()

    data = request.json
    if log := data.get('log', None):
        process_log(frame, log)

    if logs := data.get('logs', None):
        for log in logs:
            process_log(frame, log)

    return 'OK', 200
