from threading import Thread, Lock
import time
from geventwebsocket import WebSocketApplication

clients = set()
lock = Lock()

class FrameAgentApplication(WebSocketApplication):
    def on_open(self):
        print("WebSocket connection established")
        with lock:
            clients.add(self.ws)

    def on_message(self, message):
        if message is None:
            print("Client disconnected")
            self.on_close()
        else:
            print(f"Received from client: {message}")

    def on_close(self, reason=''):
        with lock:
            clients.discard(self.ws)
            print(f"Client removed: {reason}")

def ping_clients():
    while True:
        with lock:
            for ws in list(clients):
                try:
                    ws.send('ping')
                except Exception as e:
                    print(f"Error pinging client: {e}")
                    clients.remove(ws)
        # Ping every minute
        time.sleep(60)

# Start the ping thread
Thread(target=ping_clients, daemon=True).start()
