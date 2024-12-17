import asyncio
import json
from typing import List
from redis.asyncio import from_url as create_redis

from fastapi import WebSocket, WebSocketDisconnect

from app.config import get_config

redis = None

async def init_redis():
    global redis
    if redis is None:
        redis = create_redis(get_config().REDIS_URL, decode_responses=True)

async def publish_message(event: str, data: dict):
    if not redis:
        await init_redis()
    msg = {"event": event, "data": data}
    await redis.publish("broadcast_channel", json.dumps(msg))


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active_connections.append(websocket)
        print(f"Websocket client connected: {websocket.client}")

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        print(f"Websocket client disconnected: {websocket.client}")

    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def broadcast(self, message: str):
        async with self.lock:
            for connection in self.active_connections:
                try:
                    await connection.send_text(message)
                except Exception as e:
                    print(f"Error sending message to {connection.client}: {e}")
                    await self.disconnect(connection)

manager = ConnectionManager()

async def redis_listener():
    await init_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe("broadcast_channel")

    async for message in pubsub.listen():
        if message["type"] == "message":
            msg = message["data"]
            await manager.broadcast(msg)


def register_ws_routes(app):
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                # Handle incoming messages
                await manager.send_personal_message(f"You said: {data}", websocket)
        except WebSocketDisconnect:
            await manager.disconnect(websocket)
        except Exception as e:
            print(f"Error: {e}")
            await manager.disconnect(websocket)

    @app.on_event("startup")
    async def startup_event():
        asyncio.create_task(redis_listener())

    return manager
