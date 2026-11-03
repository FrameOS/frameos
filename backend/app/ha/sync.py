"""
Home Assistant sync service.

Shares FrameOS frames with Home Assistant, both ways (docs/home-assistant.md):

- every non-archived frame is an MQTT-discovered device: the latest render as
  an image, status / scene / last-seen sensors, a scene select, a display
  switch, refresh / next / previous / restart / reboot buttons, and one
  entity per public field of each of its scenes (app/ha/discovery.py);
- what Home Assistant sets on those entities, and free-form commands from
  automations, come back over MQTT and go to the frame the way the editor's
  own buttons do (app/ha/commands.py → the frame event route's dispatcher);
- every meaningful frame event is forwarded to the HA event bus as
  `frameos_event` and to the frame's MQTT event topic.

Runs as a single asyncio task inside the arq worker process (the add-on runs
two uvicorns plus the worker; the worker is the one singleton). It reacts to
the same Redis `broadcast_channel` messages that feed the websockets, plus
control messages on `ha_sync` ({"event": "settings_changed" | "sync_now"}).
"Sync now" API requests are additionally left in HA_SYNC_REQUEST_KEY; the
service claims the key on (re)connect and answers on the request's reply
channel with what actually happened (broker used, frames shared, or the error).
"""

import asyncio
import contextlib
import hashlib
import json
from typing import Any, Optional

from httpx import AsyncClient
from redis.asyncio import from_url as create_redis

from app.config import config
from app.database import SessionLocal
from app.ha import HA_SYNC_CHANNEL, HA_SYNC_REQUEST_KEY
from app.ha import commands, discovery, state
from app.ha.client import MqttConfig, RestConfig, fire_ha_event, resolve_mqtt_config, resolve_rest_config
from app.redis import get_shared_redis
from app.utils.events_contract_gen import SCENE_CHANGED_LOG_EVENTS

BROADCAST_CHANNEL = "broadcast_channel"
# Log lines that mean "the frame now shows this scene" (docs/events-contract.json `logEvents`).
SCENE_CHANGE_EVENTS = SCENE_CHANGED_LOG_EVENTS
# Renders can double-fire (new_scene_image + frame_rendered); skip repeats.
IMAGE_PUBLISH_MIN_INTERVAL = 2.0
# A burst of state-change log lines (a setCurrentScene is three) is one
# re-read of the frame's state.
FIELDS_REFRESH_DELAY = 1.0


def partition_projects_by_broker(
    resolved: dict[int, Optional[MqttConfig]],
) -> tuple[Optional[MqttConfig], list[int], list[int]]:
    """Pick the broker this run connects to and split projects by it.

    Returns (broker, project ids on that broker, project ids on any other
    broker). The broker is the first project's (dict order = load order); a
    project that resolved to no broker at all counts as skipped too, since
    nothing could be published for it. Pure, so the leak rule is unit-tested
    without a broker or a Redis.
    """
    chosen: Optional[MqttConfig] = None
    kept: list[int] = []
    skipped: list[int] = []
    for project_id, broker in resolved.items():
        if broker is None:
            skipped.append(project_id)
            continue
        if chosen is None:
            chosen = broker
        if broker == chosen:
            kept.append(project_id)
        else:
            skipped.append(project_id)
    return chosen, kept, skipped


def share_scene_fields(ha_settings: dict) -> bool:
    """Settings → Home Assistant → "Scene settings as entities" (on by default)."""
    return ha_settings.get("shareSceneFields", True) is not False


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
        self._discovery_signatures: dict[int, str] = {}  # frame_id -> hash of the last discovery publish
        self._fields_refreshes: dict[int, asyncio.Task] = {}  # frame_id -> debounced fields publish
        self._command_tasks: set[asyncio.Task] = set()

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
                self._discovery_signatures = {}

                mqtt_config = None
                if self._enabled:
                    # One broker per run. As an add-on every project resolves to
                    # the Supervisor's Mosquitto; self-hosted, each project may
                    # name its own broker — and frames must only ever be
                    # published to the broker their own project configured, or
                    # project A's frames land on project B's MQTT (a
                    # cross-project leak, docs/security-todo.md). Projects on
                    # any other broker are left out of this run and said so.
                    resolved = {
                        project_id: await resolve_mqtt_config(http, ha_settings)
                        for project_id, ha_settings in self._enabled.items()
                    }
                    mqtt_config, kept, skipped = partition_projects_by_broker(resolved)
                    if skipped:
                        print(
                            "🟡 Home Assistant sync: projects "
                            + ", ".join(str(project_id) for project_id in skipped)
                            + " configure a different MQTT broker than the one this run connects to "
                            + (f"({mqtt_config.host}:{mqtt_config.port})" if mqtt_config else "")
                            + "; their frames are not shared. One broker per install is supported."
                        )
                        self._enabled = {project_id: self._enabled[project_id] for project_id in kept}
                        self._rest = {project_id: rest for project_id, rest in self._rest.items() if project_id in kept}

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
                                await mqtt.subscribe([(topic, 1) for topic in discovery.frame_command_subscriptions()])
                                await self._publish(discovery.AVAILABILITY_TOPIC, "online", retain=True)
                                await self._full_sync()
                                await self._reply_to_sync_request(mqtt_config)
                                await self._serve(pubsub, mqtt)
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
                self._cancel_background_tasks()
                try:
                    await redis_sub.close()
                except Exception:
                    pass

    async def _serve(self, pubsub, mqtt):
        """Both directions at once: Redis broadcasts out, MQTT commands in.
        Ends when the Redis side asks for a reload (settings changed, sync
        now) or either side fails."""
        redis_task = asyncio.create_task(self._listen(pubsub))
        mqtt_task = asyncio.create_task(self._listen_mqtt(mqtt))
        try:
            done, pending = await asyncio.wait({redis_task, mqtt_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
            for task in done:
                task.result()
        finally:
            for task in (redis_task, mqtt_task):
                if not task.done():
                    task.cancel()

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

    async def _listen_mqtt(self, mqtt):
        async for message in mqtt.messages:
            topic = message.topic
            topic_text = str(getattr(topic, "value", topic))
            self._spawn_command(topic_text, message.payload)

    def _spawn_command(self, topic: str, payload: Any) -> asyncio.Task:
        # A command may wait on the frame (a Pi over HTTP, an ESP32's ack):
        # run it beside the loops so the next message is not behind it.
        task = asyncio.create_task(self._handle_command(topic, payload))
        self._command_tasks.add(task)
        task.add_done_callback(self._command_tasks.discard)
        return task

    def _cancel_background_tasks(self):
        for task in list(self._command_tasks) + list(self._fields_refreshes.values()):
            if not task.done():
                task.cancel()
        self._command_tasks.clear()
        self._fields_refreshes.clear()

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

    # ---- commands from Home Assistant -------------------------------------------

    async def _handle_command(self, topic_text: str, payload: Any) -> Optional[commands.Action]:
        topic = commands.parse_topic(topic_text)
        if topic is None or topic.project_id not in self._enabled:
            return None
        frame = self._load_frame_dict(topic.frame_id)
        if not frame or frame.get("archived") or frame.get("project_id") != topic.project_id:
            return None
        redis = get_shared_redis()
        active = await self._active_scene_id(topic.frame_id)
        pending = await state.get_pending_states(redis, topic.frame_id)
        action = commands.resolve_command(topic, payload, frame, active, pending)
        await self._execute(frame, action)
        return action

    async def _execute(self, frame: dict, action: commands.Action) -> None:
        from app.models.frame import Frame
        from app.models.log import new_log

        frame_id, project_id = int(frame["id"]), int(frame["project_id"])
        redis = get_shared_redis()
        db = SessionLocal()
        try:
            row = db.get(Frame, frame_id)
            if row is None:
                return
            if action.kind == "error":
                await new_log(db, redis, frame_id, "stderr", f"Home Assistant: {action.message}")
                return
            if action.kind == "store_field":
                await state.store_pending_state(redis, frame_id, action.scene_id or "", action.state)
                await new_log(db, redis, frame_id, "stdinfo", f"Home Assistant set {action.summary}")
                await self._publish_fields(frame, live=False)
                return
            await new_log(db, redis, frame_id, "stdinfo", f"Home Assistant asked for {action.summary}")
            try:
                if action.kind in ("restart", "reboot"):
                    from app.api.frames import _begin_control_progress_for
                    from app.tasks import reboot_frame, restart_frame

                    await _begin_control_progress_for(db, redis, row, action.kind)
                    await (restart_frame if action.kind == "restart" else reboot_frame)(frame_id, redis)
                    return
                await self._dispatch(db, redis, row, action.event or "", action.payload)
            except Exception as error:
                detail = getattr(error, "detail", None) or str(error)
                await new_log(db, redis, frame_id, "stderr", f"Home Assistant's {action.summary} failed: {detail}")
                return
            if action.consumes_pending:
                await state.clear_pending_state(redis, frame_id, action.consumes_pending)
            if action.event in ("turnOn", "turnOff"):
                # The frame logs event:turnOn/turnOff itself when it takes
                # it; until then, say what was asked so the switch settles.
                await state.set_display_power(redis, frame_id, action.event == "turnOn")
                await self._publish_state(frame)
            if action.event in ("setCurrentScene", "setSceneState"):
                await self._publish_state(frame)
                self._schedule_fields_refresh(project_id, frame_id)
        finally:
            db.close()

    async def _dispatch(self, db, redis, frame, event: str, payload: dict) -> Any:
        """The frame event route's dispatcher; a seam for tests."""
        from app.api.frames import dispatch_frame_event

        return await dispatch_frame_event(db, redis, frame, event, payload)

    # ---- event handling ------------------------------------------------------

    async def _handle_broadcast(self, event: Optional[str], data: dict):
        if event in ("new_frame", "update_frame"):
            project_id, frame_id = data.get("project_id"), data.get("id")
            if project_id not in self._enabled or frame_id is None:
                return
            # "update_frame" is also published with partial payloads (the Remote
            # websocket sends just {id, project_id, active_connections} on
            # connect/disconnect). Discovery and state always come from the
            # persisted row, otherwise a partial payload renames the device to
            # "Frame N" and retains a null status. The payload is only the
            # fallback for a row that is already gone.
            frame = self._load_frame_dict(frame_id) or data
            if frame.get("project_id") != project_id:
                return
            self._frames[frame_id] = {
                "project_id": project_id,
                "name": frame.get("name"),
                "archived": bool(frame.get("archived")),
            }
            if frame.get("archived"):
                await self._remove_frame(project_id, frame_id)
            else:
                await self._publish_frame(frame)
            await self._publish_summary(project_id)
        elif event == "delete_frame":
            project_id, frame_id = data.get("project_id"), data.get("id")
            if project_id not in self._enabled or frame_id is None:
                return
            self._frames.pop(frame_id, None)
            await self._remove_frame(project_id, frame_id)
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

        # The frame saying what its panel did: the display switch's truth.
        display_changed = event in state.DISPLAY_LOG_EVENTS and await state.note_display_log(
            get_shared_redis(), frame_id, event
        )
        # Scene changes only touch Redis (no update_frame broadcast), so refresh
        # the frame's state topic here to keep the scene sensor current.
        if display_changed or event in SCENE_CHANGE_EVENTS:
            frame = self._load_frame_dict(frame_id)
            if frame and not frame.get("archived"):
                await self._publish_state(frame)
        # State changed on the frame (a button, a schedule, the editor): the
        # field entities re-read it, once the burst of lines is over.
        if event in state.FIELDS_LOG_EVENTS:
            self._schedule_fields_refresh(project_id, frame_id)

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
                await self._publish_frame(frame, force=True)
                await self._publish_frame_image(project_id, frame["id"], throttle=False)
            for frame in frames:
                if frame.get("archived"):
                    await self._remove_frame(project_id, frame["id"])
            print(f"🟢 Home Assistant sync: shared {len(active)} frame(s) for project {project_id}")

    async def _publish_frame(self, frame: dict, force: bool = False):
        """Discovery (when it changed, or `force`), state, and a fields
        refresh when the scenes changed. Entities a scene change left behind
        are retracted by the keys recorded for the frame."""
        project_id, frame_id = int(frame["project_id"]), int(frame["id"])
        redis = get_shared_redis()
        include_fields = share_scene_fields(self._enabled.get(project_id, {}))
        messages = discovery.frame_discovery_messages(frame, include_fields=include_fields)
        signature = hashlib.sha1(json.dumps(messages, sort_keys=True, default=str).encode()).hexdigest()
        changed = force or self._discovery_signatures.get(frame_id) != signature
        if changed:
            keys = discovery.frame_entity_keys(frame, include_fields=include_fields)
            tracked = await state.get_tracked_entities(redis, frame_id)
            stale = tracked - keys
            if stale:
                await self._publish_messages(discovery.entity_removal_messages(project_id, frame_id, stale))
            await self._publish_messages(messages)
            await state.set_tracked_entities(redis, frame_id, keys)
            self._discovery_signatures[frame_id] = signature
        await self._publish_state(frame)
        if changed and include_fields:
            self._schedule_fields_refresh(project_id, frame_id)

    async def _remove_frame(self, project_id: int, frame_id: int):
        redis = get_shared_redis()
        tracked = await state.get_tracked_entities(redis, frame_id)
        await self._publish_messages(discovery.frame_removal_messages(project_id, frame_id, tracked))
        for topic in (
            discovery.frame_state_topic(project_id, frame_id),
            discovery.frame_fields_topic(project_id, frame_id),
            discovery.frame_image_topic(project_id, frame_id),
        ):
            await self._publish(topic, None, retain=True)
        await state.set_tracked_entities(redis, frame_id, set())
        self._discovery_signatures.pop(frame_id, None)

    async def _publish_state(self, frame: dict):
        project_id, frame_id = int(frame["project_id"]), int(frame["id"])
        await self._publish_json(
            discovery.frame_state_topic(project_id, frame_id),
            discovery.frame_state_payload(
                frame,
                await self._active_scene_id(frame_id),
                await state.get_display_power(get_shared_redis(), frame_id),
            ),
            retain=True,
        )

    def _schedule_fields_refresh(self, project_id: int, frame_id: int, delay: float = FIELDS_REFRESH_DELAY):
        if not share_scene_fields(self._enabled.get(project_id, {})):
            return
        previous = self._fields_refreshes.pop(frame_id, None)
        if previous is not None and not previous.done():
            previous.cancel()

        async def refresh():
            try:
                await asyncio.sleep(delay)
                frame = self._load_frame_dict(frame_id)
                if frame and not frame.get("archived"):
                    await self._publish_fields(frame, live=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"🔴 Home Assistant sync: failed to publish scene fields for frame {frame_id}: {e}")

        task = asyncio.create_task(refresh())
        self._fields_refreshes[frame_id] = task

        def forget(done: asyncio.Task) -> None:
            if self._fields_refreshes.get(frame_id) is done:
                self._fields_refreshes.pop(frame_id, None)

        task.add_done_callback(forget)

    async def _publish_fields(self, frame: dict, live: bool = True):
        """The fields topic: every scene's public field values as text."""
        from app.models.frame import Frame

        project_id, frame_id = int(frame["project_id"]), int(frame["id"])
        if not share_scene_fields(self._enabled.get(project_id, {})):
            return
        redis = get_shared_redis()
        db = SessionLocal()
        try:
            row = db.get(Frame, frame_id)
            states = await state.frame_scene_states(redis, row, live=live) if row is not None else {}
        finally:
            db.close()
        pending = await state.get_pending_states(redis, frame_id)
        await self._publish_json(
            discovery.frame_fields_topic(project_id, frame_id),
            discovery.fields_state_payload(frame, states, pending),
            retain=True,
        )

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
