import asyncio
import json
from jose import jwt, JWTError
from typing import List
from redis.asyncio import from_url as create_redis, Redis
from fastapi import WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session
from app.database import get_db

from app.config import config
from app.models.user import User
from app.models.agent import Agent
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

class AgentConnectionManager:
    def __init__(self):
        self._sockets: dict[str, WebSocket] = {}   # device_id → WebSocket
        self._lock = asyncio.Lock()

    async def connect(self, device_id: str, websocket: WebSocket):
        async with self._lock:
            self._sockets[device_id] = websocket
        print(f"▶️  agent {device_id} connected from {websocket.client}")

    async def disconnect(self, device_id: str):
        async with self._lock:
            self._sockets.pop(device_id, None)
        print(f"❌ agent {device_id} disconnected")

    async def send(self, device_id: str, msg: str):
        async with self._lock:
            ws = self._sockets.get(device_id)
        if ws:
            await ws.send_text(msg)

agent_manager = AgentConnectionManager()

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
    async def websocket_endpoint(websocket: WebSocket, db: Session = Depends(get_db)):
        # Full access in the HASSIO ingress mode
        if config.HASSIO_RUN_MODE != "ingress":
            token = websocket.query_params.get('token')
            if not token:
                await websocket.close(code=1008, reason="Missing token")
                return

            try:
                from app.api.auth import ALGORITHM, SECRET_KEY
                payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
                user_email = payload.get("sub")
                if not user_email:
                    raise ValueError("Invalid token")
            except JWTError:
                await websocket.close(code=1008, reason="Invalid token")
                return

            user = db.query(User).filter(User.email == user_email).first()
            if user is None:
                await websocket.close(code=1008, reason="User not found")
                return

        await manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                await manager.send_personal_message(json.dumps({'event': "pong", 'payload': data}), websocket)
        except WebSocketDisconnect:
            await manager.disconnect(websocket)

    # ------------------------------------------------------------------------
    @app.websocket("/ws/agent")
    async def websocket_agent(
        websocket: WebSocket,
        db: Session = Depends(get_db)
    ):
        """
        Handshake message **must** be the very first packet:
            {"action":"handshake","deviceId":"abc-123","serverKey":""}
        • If we have no record of `deviceId`, we create one and return a fresh
          `serverKey`.
        • If serverKey mismatches, we still send the server copy back – the
          device must update its local copy.
        Afterwards we keep the socket open for future commands.
        """
        await websocket.accept()
        try:
            hello_raw = await websocket.receive_text()
            hello     = json.loads(hello_raw)
            if hello.get("action") != "handshake":
                await websocket.close(code=1008, reason="bad handshake")
                return

            dev_id   = str(hello.get("deviceId") or "").strip()
            cli_key  = str(hello.get("serverKey") or "").strip()

            if not dev_id:
                await websocket.close(code=1008, reason="missing deviceId")
                return

            agent = db.query(Agent).filter_by(device_id=dev_id).first()
            if not agent:
                agent = Agent(device_id=dev_id)          # server_key auto-gen
                db.add(agent)
                db.commit()
                db.refresh(agent)

            # send handshake ACK
            await websocket.send_text(json.dumps({
                "action":   "handshake/ack",
                "serverKey": agent.server_key
            }))

            # simple mismatch warning (not fatal)
            if cli_key and cli_key != agent.server_key:
                print(f"⚠️  serverKey mismatch for {dev_id}; client will update")

            await agent_manager.connect(dev_id, websocket)

            # ---- main loop -------------------------------------------------
            while True:
                msg = await websocket.receive_text()
                # add your own message/command handling here
                print(f"[{dev_id}] {msg}")

        except WebSocketDisconnect:
            pass
        finally:
            await agent_manager.disconnect(dev_id)
