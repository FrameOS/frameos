from gevent import monkey
monkey.patch_all()

from app import socketio, create_app

if __name__ == '__main__':
    app = create_app()
    print("Starting server")
    socketio.run(app, host='0.0.0.0', port=8989, allow_unsafe_werkzeug=True, debug=True)
    print("Server started")
