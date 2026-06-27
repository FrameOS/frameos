import asyncio
import json
from typing import List
from redis.asyncio import from_url as create_redis, Redis
from fastapi import WebSocket, WebSocketDisconnect

from app.database import SessionLocal
from app.models.organization import OrganizationMember, Project

from app.config import config
from app.utils.env import get_env_float


WEBSOCKET_BROADCAST_TIMEOUT = get_env_float("WEBSOCKET_BROADCAST_TIMEOUT", 2.0)
PROJECT_SCOPED_EVENTS = {
    "ai_scene_log",
    "delete_frame",
    "frame_rendered",
    "new_frame",
    "new_log",
    "new_metrics",
    "new_scene_image",
    "update_frame",
}


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connection_project_ids: dict[WebSocket, set[int] | None] = {}
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, project_ids: set[int] | None = None):
        await websocket.accept()
        async with self.lock:
            self.active_connections.append(websocket)
            self.connection_project_ids[websocket] = project_ids
        print(f"Websocket client connected: {websocket.client}")

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            self.connection_project_ids.pop(websocket, None)
        print(f"Websocket client disconnected: {websocket.client}")

    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    def _message_project_id(self, message: str) -> tuple[str | None, int | None]:
        try:
            parsed = json.loads(message)
        except json.JSONDecodeError:
            return None, None

        event = parsed.get("event")
        data = parsed.get("data")
        if not isinstance(data, dict):
            return event, None

        project_id = data.get("project_id")
        if project_id is None:
            return event, None
        try:
            return event, int(project_id)
        except (TypeError, ValueError):
            return event, None

    def _can_receive(self, websocket: WebSocket, event: str | None, project_id: int | None) -> bool:
        allowed_project_ids = self.connection_project_ids.get(websocket)
        if allowed_project_ids is None:
            return True
        if project_id is None:
            return event not in PROJECT_SCOPED_EVENTS
        return project_id in allowed_project_ids

    async def broadcast(self, message: str):
        stale_connections: list[WebSocket] = []
        event, project_id = self._message_project_id(message)
        async with self.lock:
            connections = [
                connection
                for connection in self.active_connections
                if self._can_receive(connection, event, project_id)
            ]

        async def send(connection: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(
                    connection.send_text(message),
                    timeout=WEBSOCKET_BROADCAST_TIMEOUT,
                )
            except Exception as e:
                print(f"Error sending message to {connection.client}: {e}")
                return connection
            return None

        results = await asyncio.gather(*(send(connection) for connection in connections))
        stale_connections = [connection for connection in results if connection is not None]

        if stale_connections:
            async with self.lock:
                for connection in stale_connections:
                    if connection in self.active_connections:
                        self.active_connections.remove(connection)
                    self.connection_project_ids.pop(connection, None)

manager = ConnectionManager() # Local clients

async def redis_listener():
    # Reconnect forever: a dropped Redis connection must not permanently kill
    # cross-instance websocket broadcasts. Only an explicit cancel stops us.
    backoff = 1.0
    while True:
        redis_sub = create_redis(config.REDIS_URL, decode_responses=True)
        try:
            pubsub = redis_sub.pubsub()
            await pubsub.subscribe("broadcast_channel")
            backoff = 1.0  # reset once a subscription is established

            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        parsed = json.loads(message["data"])
                        # Only broadcast if not from this instance
                        if parsed.get("instance_id") != config.INSTANCE_ID:
                            await manager.broadcast(message["data"])
                    except json.JSONDecodeError:
                        pass
        except asyncio.CancelledError:
            await redis_sub.close()
            raise
        except Exception as e:
            print(f"redis_listener connection error, reconnecting in {backoff:.0f}s: {e}")
        finally:
            try:
                await redis_sub.close()
            except Exception:
                pass

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)

async def publish_message(redis: Redis, event: str, data: dict):
    msg = {"event": event, "data": data, "instance_id": config.INSTANCE_ID}

    # Broadcast locally first
    await manager.broadcast(json.dumps(msg))

    # Then publish to redis
    await redis.publish("broadcast_channel", json.dumps(msg))

def register_ws_routes(app):
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        project_ids = None
        # Full access in the HASSIO ingress mode
        if config.HASSIO_RUN_MODE != "ingress":
            from app.api.auth import get_current_user_from_websocket

            db = SessionLocal()
            try:
                user, error_reason = get_current_user_from_websocket(websocket, db)
                if user is not None:
                    project_ids = {
                        int(project_id)
                        for (project_id,) in (
                            db.query(Project.id)
                            .join(OrganizationMember, OrganizationMember.organization_id == Project.organization_id)
                            .filter(OrganizationMember.user_id == user.id)
                            .all()
                        )
                    }
            finally:
                db.close()

            if user is None:
                await websocket.close(code=1008, reason=error_reason or "Could not validate credentials")
                return

        await manager.connect(websocket, project_ids=project_ids)
        try:
            while True:
                data = await websocket.receive_text()
                await manager.send_personal_message(json.dumps({'event': "pong", 'payload': data}), websocket)
        except WebSocketDisconnect:
            await manager.disconnect(websocket)

    return manager
