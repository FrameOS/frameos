from app import app, db
from flask import render_template, request, jsonify
from app.models import Frame

@app.route("/", methods=["GET"])
def home():
    frames = Frame.query.all()
    # frames = db.session.query(Frame).all()
    return render_template("index.html", frames=frames)

@app.route("/frames/new", methods=["POST"])
def new_frame():
    ip = request.form['ip']
    frame = Frame(ip=ip, port=8999, status="uninitialized")
    db.session.add(frame)
    db.session.commit()
    return render_template("frame.html", frame=frame, index=9)

@app.route("/frames/<int:id>/delete", methods=["DELETE"])
def delete_frame(id):
    return ('', 200)
