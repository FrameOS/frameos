from backend import app, socketio, db, migrate

if __name__ == '__main__':
    with app.app_context():
        db.create_all()

    socketio.run(app, host='0.0.0.0', port=8999, debug=True)
