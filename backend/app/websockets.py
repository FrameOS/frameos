import asyncio
import json
from typing import List
from redis.asyncio import from_url as create_redis, Redis
from fastapi import WebSocket, WebSocketDisconnect

from app.database import SessionLocal

from app.config import config


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

manager = ConnectionManager() # Local clients

async def redis_listener():
    redis_sub = create_redis(config.REDIS_URL, decode_responses=True)
    try:
        pubsub = redis_sub.pubsub()
        await pubsub.subscribe("broadcast_channel")

        async for message in pubsub.listen():
            if message["type"] == "message":
                try:
                    parsed = json.loads(message["data"])
                    # Only broadcast if not from this instance
                    if parsed.get("instance_id") != config.INSTANCE_ID:
                        await manager.broadcast(message["data"])
                except json.JSONDecodeError:
                    pass
    finally:
        await redis_sub.close()

async def publish_message(redis: Redis, event: str, data: dict):
    msg = {"event": event, "data": data, "instance_id": config.INSTANCE_ID}

    # Broadcast locally first
    await manager.broadcast(json.dumps(msg))

    # Then publish to redis
    await redis.publish("broadcast_channel", json.dumps(msg))

def register_ws_routes(app):
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        # Full access in the HASSIO ingress mode
        if config.HASSIO_RUN_MODE != "ingress":
            from app.api.auth import get_current_user_from_websocket

            db = SessionLocal()
            try:
                user, error_reason = get_current_user_from_websocket(websocket, db)
            finally:
                db.close()

            if user is None:
                await websocket.close(code=1008, reason=error_reason or "Could not validate credentials")
                return

        await manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                await manager.send_personal_message(json.dumps({'event': "pong", 'payload': data}), websocket)
        except WebSocketDisconnect:
            await manager.disconnect(websocket)

    return manager
