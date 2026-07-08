"""
Home Assistant sync service.

Shares FrameOS frames with Home Assistant: every non-archived frame becomes an
MQTT-discovered device (image entity with the latest render, status/scene/last
seen sensors), a hub sensor reports the frame count and names, and every
meaningful frame event is forwarded to the HA event bus as `frameos_event` and
to the frame's MQTT event topic.

Runs as a single asyncio task inside the arq worker process (the add-on runs
two uvicorns plus the worker; the worker is the one singleton). It reacts to
the same Redis `broadcast_channel` messages that feed the websockets, plus
control messages on `ha_sync` ({"event": "settings_changed" | "sync_now"}).
"Sync now" API requests are additionally left in HA_SYNC_REQUEST_KEY; the
service claims the key on (re)connect and answers on the request's reply
channel with what actually happened (broker used, frames shared, or the error).
"""

import asyncio
import json
from typing import Any, Optional

from httpx import AsyncClient
from redis.asyncio import from_url as create_redis

from app.config import config
from app.database import SessionLocal
from app.ha import HA_SYNC_CHANNEL, HA_SYNC_REQUEST_KEY
from app.ha import discovery
from app.ha.client import MqttConfig, RestConfig, fire_ha_event, resolve_mqtt_config, resolve_rest_config
from app.redis import get_shared_redis

BROADCAST_CHANNEL = "broadcast_channel"
SCENE_CHANGE_EVENTS = ("render:scene", "render:sceneChange", "event:setCurrentScene")
# Renders can double-fire (new_scene_image + frame_rendered); skip repeats.
IMAGE_PUBLISH_MIN_INTERVAL = 2.0


class HomeAssistantSync:
    def __init__(self):
        self._mqtt: Any = None  # aiomqtt.Client while connected
        self._http: Optional[AsyncClient] = None
        self._enabled: dict[int, dict] = {}  # project_id -> homeAssistant settings
        self._rest: dict[int, RestConfig] = {}  # project_id -> HA event bus access
        self._frames: dict[int, dict] = {}  # frame_id -> {project_id, name, archived}
        self._last_image_publish: dict[int, float] = {}
        self._sync_request: Optional[dict] = None  # pending "sync now" API request awaiting a reply
        self._synced_counts: dict[int, int] = {}  # project_id -> frames shared in the last full sync

    # ---- lifecycle ----------------------------------------------------------

    async def run(self):
        backoff = 5.0
        while True:
            try:
                await self._run_once()
                backoff = 5.0  # graceful reload (settings changed): reconnect now
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"🔴 Home Assistant sync error, retrying in {backoff:.0f}s: {e}")
                await self._reply_to_sync_request(None, error=str(e))
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _run_once(self):
        redis_sub = create_redis(config.REDIS_URL, decode_responses=True)
        async with AsyncClient() as http:
            self._http = http
            try:
                pubsub = redis_sub.pubsub()
                await pubsub.subscribe(BROADCAST_CHANNEL, HA_SYNC_CHANNEL)
                # Claim a pending "sync now" request only after subscribing:
                # requests written later nudge HA_SYNC_CHANNEL, which we now see.
                await self._claim_sync_request()

                self._enabled = self._load_enabled_projects()
                self._rest = {
                    project_id: rest
                    for project_id, ha_settings in self._enabled.items()
                    if (rest := resolve_rest_config(ha_settings)) is not None
                }
                self._synced_counts = {}

                mqtt_config = None
                if self._enabled:
                    # One broker for the whole install: the Supervisor's Mosquitto
                    # service as an add-on, or the settings-configured broker.
                    any_settings = next(iter(self._enabled.values()))
                    mqtt_config = await resolve_mqtt_config(http, any_settings)

                if mqtt_config:
                    import aiomqtt

                    will = aiomqtt.Will(
                        topic=discovery.AVAILABILITY_TOPIC, payload="offline", qos=1, retain=True
                    )
                    connected = False
                    try:
                        async with aiomqtt.Client(
                            hostname=mqtt_config.host,
                            port=mqtt_config.port,
                            username=mqtt_config.username,
                            password=mqtt_config.password,
                            will=will,
                        ) as mqtt:
                            self._mqtt = mqtt
                            connected = True
                            print(f"🟢 Home Assistant sync: connected to MQTT broker at {mqtt_config.host}:{mqtt_config.port}")
                            try:
                                await self._publish(discovery.AVAILABILITY_TOPIC, "online", retain=True)
                                await self._full_sync()
                                await self._reply_to_sync_request(mqtt_config)
                                await self._listen(pubsub)
                            finally:
                                try:
                                    await self._publish(discovery.AVAILABILITY_TOPIC, "offline", retain=True)
                                except Exception:
                                    pass
                                self._mqtt = None
                    except aiomqtt.MqttError as e:
                        broker = f"{mqtt_config.host}:{mqtt_config.port}"
                        if connected:
                            # Credentials were fine: the broker accepted us and then cut the
                            # connection (oversized messages and duplicate client IDs are
                            # common causes) — its own log has the reason.
                            raise RuntimeError(
                                f"MQTT broker {broker} dropped the connection while syncing: {e}. "
                                "See the Mosquitto broker log in Home Assistant for the reason "
                                "(for example a message size limit)."
                            ) from e
                        credentials_hint = (
                            "the Mosquitto add-on's configuration"
                            if config.SUPERVISOR_TOKEN
                            else "the MQTT settings under Settings → Home Assistant"
                        )
                        raise RuntimeError(
                            f"MQTT broker {broker} connection failed: {e}. Check {credentials_hint}."
                        ) from e
                else:
                    if self._enabled:
                        print(
                            "🟡 Home Assistant sync: enabled, but no MQTT broker found "
                            "(install the Mosquitto add-on or set an MQTT broker in settings). "
                            "Events are still forwarded to the HA event bus."
                        )
                    await self._reply_to_sync_request(None)
                    await self._listen(pubsub)
            finally:
                self._http = None
                try:
                    await redis_sub.close()
                except Exception:
                    pass

    async def _listen(self, pubsub):
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                parsed = json.loads(message["data"])
            except (TypeError, ValueError):
                continue
            if not isinstance(parsed, dict):
                continue
            if message.get("channel") == HA_SYNC_CHANNEL:
                if parsed.get("event") == "settings_changed":
                    print("🔄 Home Assistant sync: settings changed, reloading")
                    return  # run() reconnects with fresh settings
                if parsed.get("event") == "sync_now":
                    print("🔄 Home Assistant sync: full sync requested, reloading")
                    return  # run() reconnects, resyncs, and answers the pending request
                continue
            data = parsed.get("data")
            if isinstance(data, dict):
                await self._handle_broadcast(parsed.get("event"), data)

    # ---- sync-now request/reply ----------------------------------------------

    async def _claim_sync_request(self):
        try:
            redis = get_shared_redis()
            raw = await redis.get(HA_SYNC_REQUEST_KEY)
            if not raw:
                return
            await redis.delete(HA_SYNC_REQUEST_KEY)
            request = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except Exception:
            return
        if isinstance(request, dict) and request.get("reply_channel"):
            self._sync_request = request

    async def _reply_to_sync_request(self, mqtt_config: Optional[MqttConfig], error: Optional[str] = None):
        """Answer a pending "Save & sync now" API request with what actually happened."""
        request, self._sync_request = self._sync_request, None
        if not request:
            return
        payload = {
            "ok": error is None and mqtt_config is not None,
            "error": error,
            "supervisor": bool(config.SUPERVISOR_TOKEN),
            "mqtt": {"host": mqtt_config.host, "port": mqtt_config.port} if mqtt_config else None,
            "enabled_project_ids": sorted(self._enabled.keys()),
            "event_bus_project_ids": sorted(self._rest.keys()),
            "frames_shared": {str(project_id): count for project_id, count in self._synced_counts.items()},
        }
        try:
            await get_shared_redis().publish(str(request["reply_channel"]), json.dumps(payload))
        except Exception as e:
            print(f"🔴 Home Assistant sync: failed to answer sync request: {e}")

    # ---- event handling ------------------------------------------------------

    async def _handle_broadcast(self, event: Optional[str], data: dict):
        if event in ("new_frame", "update_frame"):
            project_id, frame_id = data.get("project_id"), data.get("id")
            if project_id not in self._enabled or frame_id is None:
                return
            self._frames[frame_id] = {
                "project_id": project_id,
                "name": data.get("name"),
                "archived": bool(data.get("archived")),
            }
            if data.get("archived"):
                await self._publish_messages(discovery.frame_removal_messages(project_id, frame_id))
            else:
                await self._publish_messages(discovery.frame_discovery_messages(data))
                await self._publish_json(
                    discovery.frame_state_topic(project_id, frame_id),
                    discovery.frame_state_payload(data, await self._active_scene_id(frame_id)),
                    retain=True,
                )
            await self._publish_summary(project_id)
        elif event == "delete_frame":
            project_id, frame_id = data.get("project_id"), data.get("id")
            if project_id not in self._enabled or frame_id is None:
                return
            self._frames.pop(frame_id, None)
            await self._publish_messages(discovery.frame_removal_messages(project_id, frame_id))
            await self._publish_summary(project_id)
        elif event in ("new_scene_image", "frame_rendered"):
            frame_id = data.get("frameId")
            if frame_id is None:
                return
            info = self._frame_info(frame_id)
            if not info or info["project_id"] not in self._enabled or info["archived"]:
                return
            await self._publish_frame_image(info["project_id"], frame_id)
        elif event == "new_log":
            await self._handle_log(data)

    async def _handle_log(self, data: dict):
        if data.get("type") != "webhook":
            return
        project_id, frame_id = data.get("project_id"), data.get("frame_id")
        if project_id not in self._enabled or frame_id is None:
            return
        info = self._frame_info(frame_id)
        if not info or info["archived"]:
            return
        try:
            log = json.loads(data.get("line") or "")
        except (TypeError, ValueError):
            return
        if not isinstance(log, dict):
            return
        event = log.get("event", "log")
        if not isinstance(event, str) or event in discovery.SKIPPED_LOG_EVENTS:
            return

        payload = discovery.ha_event_payload(frame_id, project_id, info["name"], event, log)
        await self._publish_json(discovery.frame_event_topic(project_id, frame_id), payload)
        rest = self._rest.get(project_id)
        if rest and self._http is not None:
            await fire_ha_event(self._http, rest, discovery.HA_EVENT_TYPE, payload)

        # Scene changes only touch Redis (no update_frame broadcast), so refresh
        # the frame's state topic here to keep the scene sensor current.
        if event in SCENE_CHANGE_EVENTS:
            frame = self._load_frame_dict(frame_id)
            if frame and not frame.get("archived"):
                await self._publish_json(
                    discovery.frame_state_topic(project_id, frame_id),
                    discovery.frame_state_payload(frame, await self._active_scene_id(frame_id)),
                    retain=True,
                )

    # ---- sync ----------------------------------------------------------------

    async def _full_sync(self):
        self._synced_counts = {}
        for project_id in self._enabled:
            frames = self._load_project_frames(project_id)
            active = [frame for frame in frames if not frame.get("archived")]
            self._synced_counts[project_id] = len(active)
            for frame in frames:
                self._frames[frame["id"]] = {
                    "project_id": project_id,
                    "name": frame.get("name"),
                    "archived": bool(frame.get("archived")),
                }

            topic, payload = discovery.summary_discovery_message(project_id)
            await self._publish_json(topic, payload, retain=True)
            await self._publish_json(
                discovery.summary_state_topic(project_id),
                discovery.summary_state_payload(active),
                retain=True,
            )
            for frame in active:
                await self._publish_messages(discovery.frame_discovery_messages(frame))
                await self._publish_json(
                    discovery.frame_state_topic(project_id, frame["id"]),
                    discovery.frame_state_payload(frame, await self._active_scene_id(frame["id"])),
                    retain=True,
                )
                await self._publish_frame_image(project_id, frame["id"], throttle=False)
            for frame in frames:
                if frame.get("archived"):
                    await self._publish_messages(discovery.frame_removal_messages(project_id, frame["id"]))
            print(f"🟢 Home Assistant sync: shared {len(active)} frame(s) for project {project_id}")

    async def _publish_summary(self, project_id: int):
        active = [frame for frame in self._load_project_frames(project_id) if not frame.get("archived")]
        await self._publish_json(
            discovery.summary_state_topic(project_id),
            discovery.summary_state_payload(active),
            retain=True,
        )

    async def _publish_frame_image(self, project_id: int, frame_id: int, throttle: bool = True):
        if self._mqtt is None:
            return
        now = asyncio.get_running_loop().time()
        if throttle and now - self._last_image_publish.get(frame_id, -IMAGE_PUBLISH_MIN_INTERVAL) < IMAGE_PUBLISH_MIN_INTERVAL:
            return
        image = await self._latest_image_bytes(frame_id)
        if image is None:
            return
        self._last_image_publish[frame_id] = now
        await self._publish(discovery.frame_image_topic(project_id, frame_id), image, retain=True)

    # ---- MQTT helpers ----------------------------------------------------------

    async def _publish(self, topic: str, payload, retain: bool = False):
        if self._mqtt is None:
            return
        await self._mqtt.publish(topic, payload=payload, retain=retain)

    async def _publish_json(self, topic: str, payload: dict, retain: bool = False):
        await self._publish(topic, json.dumps(payload), retain=retain)

    async def _publish_messages(self, messages: list[tuple[str, Optional[dict]]]):
        for topic, payload in messages:
            await self._publish(topic, json.dumps(payload) if payload is not None else None, retain=True)

    # ---- data access -----------------------------------------------------------

    def _load_enabled_projects(self) -> dict[int, dict]:
        from app.models.settings import Settings

        db = SessionLocal()
        try:
            rows = db.query(Settings).filter(Settings.key == "homeAssistant").all()
            return {
                row.project_id: row.value
                for row in rows
                if isinstance(row.value, dict) and row.value.get("syncEnabled")
            }
        finally:
            db.close()

    def _load_project_frames(self, project_id: int) -> list[dict]:
        from app.models.frame import Frame

        db = SessionLocal()
        try:
            frames = db.query(Frame).filter(Frame.project_id == project_id).all()
            return [frame.to_dict() for frame in frames]
        finally:
            db.close()

    def _load_frame_dict(self, frame_id: int) -> Optional[dict]:
        from app.models.frame import Frame

        db = SessionLocal()
        try:
            frame = db.get(Frame, frame_id)
            return frame.to_dict() if frame else None
        finally:
            db.close()

    def _frame_info(self, frame_id: int) -> Optional[dict]:
        info = self._frames.get(frame_id)
        if info is not None:
            return info
        from app.models.frame import Frame

        db = SessionLocal()
        try:
            frame = db.get(Frame, frame_id)
        finally:
            db.close()
        if frame is None:
            return None
        info = {"project_id": frame.project_id, "name": frame.name, "archived": bool(frame.archived)}
        self._frames[frame_id] = info
        return info

    async def _active_scene_id(self, frame_id: int) -> Optional[str]:
        try:
            value = await get_shared_redis().get(f"frame:{frame_id}:active_scene")
        except Exception:
            return None
        if isinstance(value, bytes):
            return value.decode(errors="replace")
        return value

    async def _latest_image_bytes(self, frame_id: int) -> Optional[bytes]:
        try:
            cached = await get_shared_redis().get(f"frame:{frame_id}:image")
        except Exception:
            cached = None
        if cached:
            return cached
        from app.models.scene_image import SceneImage

        db = SessionLocal()
        try:
            row = (
                db.query(SceneImage)
                .filter_by(frame_id=frame_id)
                .order_by(SceneImage.timestamp.desc())
                .first()
            )
            return row.image if row else None
        finally:
            db.close()


ha_sync_service = HomeAssistantSync()
