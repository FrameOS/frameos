from app import app, db
from flask import render_template, request
from app.models import Frame
from app.tasks import initialize_frame

@app.route("/", methods=["GET"])
def home():
    frames = Frame.query.all()
    return render_template("index.html", frames=frames)

@app.route("/frames/new", methods=["POST"])
def new_frame():
    ip = request.form['ip']
    frame = Frame(ip=ip, port=8999, status="uninitialized")
    db.session.add(frame)
    db.session.commit()
    return render_template("_frame.html", frame=frame, index=9)

@app.route("/frames/<int:id>/init", methods=["POST"])
def init_frame():
    frame = Frame.query.get(id)
    if frame is None:
        return "Frame not found", 404
    initialize_frame.delay(id)
    return "Starting...", 200

@app.route("/frames/<int:id>", methods=["GET"])
def frame(id):
    frame = Frame.query.get(id)
    if frame is None:
        return "Frame not found", 404
    return render_template("frame.html", frame=frame)

@app.route("/frames/<int:id>/delete", methods=["DELETE"])
def delete_frame(id):
    return ('', 200)
