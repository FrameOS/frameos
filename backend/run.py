import eventlet
eventlet.monkey_patch()

from app import create_app, socketio

app = create_app()

if __name__ == '__main__':
    print("Starting Flask app with WebSocket and Socket.IO support")
    socketio.run(app, host='0.0.0.0', port=8989)
