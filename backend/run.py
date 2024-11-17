from gevent import monkey
monkey.patch_all()

from geventwebsocket import WebSocketServer, Resource
from app import create_app
from app.api.agent import FrameAgentApplication

if __name__ == '__main__':
    app = create_app()
    print("Starting server")

    resource = Resource({
        '^/ws/agent': FrameAgentApplication,
        '^/.*': app
    })

    server = WebSocketServer(
        ('0.0.0.0', 8989),
        resource
    )
    server.serve_forever()
    print("Server started")
