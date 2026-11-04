import asyncio
import json

import pytest
from httpx import AsyncClient, MockTransport, Response

from app.ha import HA_SYNC_REQUEST_KEY, discovery
from app.ha.client import MqttConfig, RestConfig
from app.ha.sync import HomeAssistantSync, partition_projects_by_broker
from app.models import new_frame, update_frame
from app.models.settings import Settings


class FakeMqtt:
    def __init__(self):
        self.messages: list[tuple[str, object, bool]] = []

    async def publish(self, topic, payload=None, retain=False, **_kwargs):
        self.messages.append((topic, payload, retain))

    def topics(self):
        return [topic for topic, _payload, _retain in self.messages]

    def payload_for(self, topic):
        # The last publish wins, as a retained topic's value does.
        for message_topic, payload, _retain in reversed(self.messages):
            if message_topic == topic:
                return payload
        return None


@pytest.fixture
def service():
    service = HomeAssistantSync()
    service._mqtt = FakeMqtt()
    return service


@pytest.mark.asyncio
async def test_load_enabled_projects(db, redis, default_project, service):
    assert service._load_enabled_projects() == {}

    db.add(Settings(project_id=default_project.id, key="homeAssistant", value={"syncEnabled": True}))
    db.commit()
    enabled = service._load_enabled_projects()
    assert list(enabled.keys()) == [default_project.id]

    setting = db.query(Settings).filter_by(project_id=default_project.id, key="homeAssistant").first()
    setting.value = {"syncEnabled": False}
    db.commit()
    assert service._load_enabled_projects() == {}


@pytest.mark.asyncio
async def test_full_sync_publishes_frames_and_skips_archived(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    archived = await new_frame(db, redis, "Old frame", "localhost", "localhost")
    archived.archived = True
    await update_frame(db, redis, archived)
    project_id = frame.project_id

    service._enabled = {project_id: {"syncEnabled": True}}
    await service._full_sync()

    topics = service._mqtt.topics()
    node = discovery.frame_node_id(project_id, frame.id)
    archived_node = discovery.frame_node_id(project_id, archived.id)

    # Active frame gets discovery + state
    assert f"homeassistant/image/{node}/image/config" in topics
    assert f"homeassistant/sensor/{node}/status/config" in topics
    state = json.loads(service._mqtt.payload_for(discovery.frame_state_topic(project_id, frame.id)))
    assert state["name"] == "Kitchen"
    assert state["status"] == "uninitialized"

    # Archived frame only gets removals (empty retained payloads)
    assert service._mqtt.payload_for(f"homeassistant/image/{archived_node}/image/config") is None
    # Its retained state, fields and image are cleared, never published.
    assert service._mqtt.payload_for(discovery.frame_state_topic(project_id, archived.id)) is None
    assert service._mqtt.payload_for(discovery.frame_fields_topic(project_id, archived.id)) is None

    # Summary sensor counts only the active frame
    summary = json.loads(service._mqtt.payload_for(discovery.summary_state_topic(project_id)))
    assert summary == {"count": 1, "frames": ["Kitchen"]}
    assert service._synced_counts == {project_id: 1}


async def _next_pubsub_message(pubsub, timeout=5.0):
    async def read():
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if message is not None:
                return message
    return await asyncio.wait_for(read(), timeout)


@pytest.mark.asyncio
async def test_sync_request_is_claimed_and_answered(db, redis, service):
    await redis.set(HA_SYNC_REQUEST_KEY, json.dumps({"reply_channel": "ha_sync:reply:test", "project_id": 1}))
    pubsub = redis.pubsub()
    await pubsub.subscribe("ha_sync:reply:test")
    try:
        await service._claim_sync_request()
        assert await redis.get(HA_SYNC_REQUEST_KEY) is None

        service._enabled = {1: {"syncEnabled": True}}
        service._synced_counts = {1: 3}
        await service._reply_to_sync_request(MqttConfig(host="core-mosquitto", port=1883))

        reply = json.loads((await _next_pubsub_message(pubsub))["data"])
        assert reply["ok"] is True
        assert reply["mqtt"] == {"host": "core-mosquitto", "port": 1883}
        assert reply["frames_shared"] == {"1": 3}

        # The request is consumed: a second reply publishes nothing
        await service._reply_to_sync_request(None, error="boom")
        assert await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.2) is None
    finally:
        await pubsub.unsubscribe("ha_sync:reply:test")
        await pubsub.close()


@pytest.mark.asyncio
async def test_sync_request_error_reply(db, redis, service):
    await redis.set(HA_SYNC_REQUEST_KEY, json.dumps({"reply_channel": "ha_sync:reply:err", "project_id": 1}))
    pubsub = redis.pubsub()
    await pubsub.subscribe("ha_sync:reply:err")
    try:
        await service._claim_sync_request()
        await service._reply_to_sync_request(None, error="mqtt connect failed")
        reply = json.loads((await _next_pubsub_message(pubsub))["data"])
        assert reply["ok"] is False
        assert reply["error"] == "mqtt connect failed"
        assert reply["mqtt"] is None
    finally:
        await pubsub.unsubscribe("ha_sync:reply:err")
        await pubsub.close()


@pytest.mark.asyncio
async def test_archiving_a_frame_removes_its_device(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}

    frame_dict = frame.to_dict()
    await service._handle_broadcast("update_frame", frame_dict)
    node = discovery.frame_node_id(project_id, frame.id)
    assert f"homeassistant/sensor/{node}/status/config" in service._mqtt.topics()

    service._mqtt.messages.clear()
    frame.archived = True
    db.commit()
    await service._handle_broadcast("update_frame", {**frame_dict, "archived": True})
    removed = service._mqtt.payload_for(f"homeassistant/sensor/{node}/status/config")
    assert removed is None
    assert f"homeassistant/sensor/{node}/status/config" in service._mqtt.topics()
    summary = json.loads(service._mqtt.payload_for(discovery.summary_state_topic(project_id)))
    assert summary["count"] == 0


@pytest.mark.asyncio
async def test_delete_frame_removes_device(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}

    await service._handle_broadcast("delete_frame", {"id": frame.id, "project_id": project_id})
    node = discovery.frame_node_id(project_id, frame.id)
    assert service._mqtt.payload_for(f"homeassistant/image/{node}/image/config") is None
    assert discovery.summary_state_topic(project_id) in service._mqtt.topics()


@pytest.mark.asyncio
async def test_frames_in_disabled_projects_are_ignored(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    service._enabled = {}
    await service._handle_broadcast("update_frame", frame.to_dict())
    assert service._mqtt.messages == []


@pytest.mark.asyncio
async def test_log_events_are_forwarded_to_mqtt_and_event_bus(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}
    service._rest = {project_id: RestConfig(base_url="http://ha.local:8123/api", token="token123")}

    fired_events = []

    def handler(request):
        fired_events.append((str(request.url), json.loads(request.content)))
        return Response(200, json={"message": "Event frameos_event fired."})

    async with AsyncClient(transport=MockTransport(handler)) as http:
        service._http = http
        await service._handle_log(
            {
                "type": "webhook",
                "frame_id": frame.id,
                "project_id": project_id,
                "line": json.dumps({"event": "button_press", "button": "a"}),
            }
        )

    event_payload = json.loads(service._mqtt.payload_for(discovery.frame_event_topic(project_id, frame.id)))
    assert event_payload["event"] == "button_press"
    assert event_payload["frame_name"] == "Kitchen"
    assert event_payload["payload"] == {"button": "a"}

    assert len(fired_events) == 1
    url, body = fired_events[0]
    assert url == "http://ha.local:8123/api/events/frameos_event"
    assert body["event"] == "button_press"
    assert body["frame_id"] == frame.id


@pytest.mark.asyncio
@pytest.mark.parametrize("event", sorted(discovery.SKIPPED_LOG_EVENTS))
async def test_noisy_log_events_are_not_forwarded(db, redis, service, event):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}

    await service._handle_log(
        {
            "type": "webhook",
            "frame_id": frame.id,
            "project_id": project_id,
            "line": json.dumps({"event": event}),
        }
    )
    assert service._mqtt.messages == []


@pytest.mark.asyncio
async def test_logs_from_archived_frames_are_not_forwarded(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.archived = True
    await update_frame(db, redis, frame)
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}

    await service._handle_log(
        {
            "type": "webhook",
            "frame_id": frame.id,
            "project_id": project_id,
            "line": json.dumps({"event": "button_press"}),
        }
    )
    assert service._mqtt.messages == []


@pytest.mark.asyncio
async def test_scene_change_log_refreshes_state_topic(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.scenes = [{"id": "scene-1", "name": "Clock"}]
    await update_frame(db, redis, frame)
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}
    await redis.set(f"frame:{frame.id}:active_scene", "scene-1")

    await service._handle_log(
        {
            "type": "webhook",
            "frame_id": frame.id,
            "project_id": project_id,
            "line": json.dumps({"event": "render:sceneChange", "sceneId": "scene-1"}),
        }
    )
    state = json.loads(service._mqtt.payload_for(discovery.frame_state_topic(project_id, frame.id)))
    assert state["scene"] == "Clock"


@pytest.mark.asyncio
async def test_render_publishes_latest_image(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}
    await redis.set(f"frame:{frame.id}:image", b"\x89PNG fake image")

    await service._handle_broadcast("frame_rendered", {"project_id": project_id, "frameId": frame.id})
    image = service._mqtt.payload_for(discovery.frame_image_topic(project_id, frame.id))
    assert image == b"\x89PNG fake image"

    # A second render right away is throttled
    service._mqtt.messages.clear()
    await service._handle_broadcast("new_scene_image", {"project_id": project_id, "frameId": frame.id})
    assert service._mqtt.messages == []


def test_projects_are_only_shared_over_their_own_broker():
    # Two projects, two brokers: the run connects to the first project's
    # broker and the second project's frames stay off it. Before this, every
    # enabled project's frames were published to whichever broker the
    # first-loaded project configured.
    home = MqttConfig(host="mqtt.home", port=1883, username="a", password="x")
    office = MqttConfig(host="mqtt.office", port=1883, username="b", password="y")
    broker, kept, skipped = partition_projects_by_broker({1: home, 2: office, 3: home})
    assert broker == home
    assert kept == [1, 3]
    assert skipped == [2]

    # The add-on case: the Supervisor's Mosquitto for everyone.
    broker, kept, skipped = partition_projects_by_broker({1: home, 2: home})
    assert (broker, kept, skipped) == (home, [1, 2], [])

    # A project with no broker at all is skipped, not silently attached.
    broker, kept, skipped = partition_projects_by_broker({1: None, 2: home})
    assert (broker, kept, skipped) == (home, [2], [1])
    assert partition_projects_by_broker({}) == (None, [], [])


@pytest.mark.asyncio
async def test_partial_update_frame_payload_publishes_from_the_persisted_row(db, redis, service):
    """The Remote websocket publishes "update_frame" with just {id, project_id,
    active_connections}. Discovery used to be rebuilt from that payload, which
    renamed the HA device to "Frame N" and retained a null status."""
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.status = "ready"
    db.commit()
    project_id = frame.project_id
    service._enabled = {project_id: {"syncEnabled": True}}

    await service._handle_broadcast(
        "update_frame", {"id": frame.id, "project_id": project_id, "active_connections": 1}
    )

    node = discovery.frame_node_id(project_id, frame.id)
    config = json.loads(service._mqtt.payload_for(f"homeassistant/sensor/{node}/status/config"))
    assert config["device"]["name"] == "Kitchen"
    state = json.loads(service._mqtt.payload_for(discovery.frame_state_topic(project_id, frame.id)))
    assert state["name"] == "Kitchen"
    assert state["status"] == "ready"
    assert service._frames[frame.id]["name"] == "Kitchen"


@pytest.mark.asyncio
async def test_update_frame_for_a_deleted_row_falls_back_to_the_payload(db, redis, service):
    project_id = 1
    service._enabled = {project_id: {"syncEnabled": True}}
    await service._handle_broadcast(
        "update_frame", {"id": 987654, "project_id": project_id, "name": "Ghost", "archived": True}
    )
    node = discovery.frame_node_id(project_id, 987654)
    assert service._mqtt.payload_for(f"homeassistant/sensor/{node}/status/config") is None
    assert f"homeassistant/sensor/{node}/status/config" in service._mqtt.topics()


# ---- commands from Home Assistant -------------------------------------------------


def weather_fields():
    return [
        {"name": "city", "label": "City", "type": "string", "value": "Brussels", "access": "public"},
        {"name": "dark", "type": "boolean", "value": "false", "access": "public"},
    ]


class RecordingDispatch:
    """Stands in for the frame event route's dispatcher: records what the
    sync asked of the frame, optionally refusing."""

    def __init__(self, fail_with: str | None = None):
        self.calls: list[tuple[int, str, dict]] = []
        self.fail_with = fail_with

    async def __call__(self, db, redis, frame, event, payload):
        self.calls.append((frame.id, event, payload))
        if self.fail_with:
            raise RuntimeError(self.fail_with)
        return "OK"


async def _frame_with_scenes(db, redis, service):
    frame = await new_frame(db, redis, "Kitchen", "localhost", "localhost")
    frame.scenes = [
        {"id": "scene-1", "name": "Clock"},
        {"id": "scene-2", "name": "Weather", "fields": weather_fields()},
        {"id": "scene-3", "name": "Photos"},
    ]
    await update_frame(db, redis, frame)
    service._enabled = {frame.project_id: {"syncEnabled": True}}
    return frame


async def _last_log_line(db, frame_id):
    from app.models.log import Log

    row = db.query(Log).filter_by(frame_id=frame_id).order_by(Log.id.desc()).first()
    return row.line if row else None


@pytest.mark.asyncio
async def test_scene_select_switches_the_scene_through_the_dispatcher(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch()
    monkeypatch.setattr(service, "_dispatch", dispatch)
    await redis.set(f"frame:{frame.id}:active_scene", "scene-1")

    action = await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id}/set/scene", b"Weather")

    assert action is not None and action.kind == "event"
    assert dispatch.calls == [(frame.id, "setCurrentScene", {"sceneId": "scene-2"})]
    assert "Home Assistant asked for scene: Weather" in (await _last_log_line(db, frame.id) or "")
    # The state topic is refreshed right away.
    assert discovery.frame_state_topic(frame.project_id, frame.id) in service._mqtt.topics()


@pytest.mark.asyncio
async def test_buttons_and_the_display_switch(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch()
    monkeypatch.setattr(service, "_dispatch", dispatch)
    base = f"frameos/frame/{frame.project_id}/{frame.id}"
    await redis.set(f"frame:{frame.id}:active_scene", "scene-3")

    await service._handle_command(f"{base}/press", b"render")
    await service._handle_command(f"{base}/press", b"next_scene")
    await service._handle_command(f"{base}/set/display", b"OFF")
    assert dispatch.calls == [
        (frame.id, "render", {}),
        (frame.id, "setCurrentScene", {"sceneId": "scene-1"}),
        (frame.id, "turnOff", {}),
    ]
    # The switch settles on what was asked until the frame says otherwise.
    state = json.loads(service._mqtt.payload_for(discovery.frame_state_topic(frame.project_id, frame.id)))
    assert state["display"] == "OFF"

    enqueued = []

    async def fake_restart(frame_id, redis_client):
        enqueued.append(("restart", frame_id))

    async def fake_reboot(frame_id, redis_client):
        enqueued.append(("reboot", frame_id))

    import app.tasks

    monkeypatch.setattr(app.tasks, "restart_frame", fake_restart)
    monkeypatch.setattr(app.tasks, "reboot_frame", fake_reboot)
    await service._handle_command(f"{base}/press", b"restart")
    await service._handle_command(f"{base}/press", b"reboot")
    assert enqueued == [("restart", frame.id), ("reboot", frame.id)]
    assert len(dispatch.calls) == 3  # restart/reboot are tasks, not frame events


@pytest.mark.asyncio
async def test_refresh_image_fetches_the_panel_and_republishes(db, redis, service, monkeypatch):
    # "Refresh image" is the image route's pull of what the panel shows, never
    # a render: a random-photo scene keeps its photo (#661). It publishes the
    # image topic even right after a render published it.
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch()
    monkeypatch.setattr(service, "_dispatch", dispatch)
    fetched: list[int] = []

    async def fetch_image(db_, redis_, row):
        fetched.append(row.id)
        await redis.set(f"frame:{row.id}:image", b"\x89PNG from the panel")

    monkeypatch.setattr(service, "_fetch_image", fetch_image)
    image_topic = discovery.frame_image_topic(frame.project_id, frame.id)
    await redis.set(f"frame:{frame.id}:image", b"\x89PNG from a render")
    await service._handle_broadcast("frame_rendered", {"project_id": frame.project_id, "frameId": frame.id})
    assert service._mqtt.payload_for(image_topic) == b"\x89PNG from a render"

    await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id}/press", b"refresh_image")
    assert fetched == [frame.id]
    assert dispatch.calls == []
    assert service._mqtt.payload_for(image_topic) == b"\x89PNG from the panel"
    assert "Home Assistant asked for refresh image" in (await _last_log_line(db, frame.id) or "")



@pytest.mark.asyncio
async def test_commands_for_other_projects_archived_or_unknown_frames_do_nothing(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch()
    monkeypatch.setattr(service, "_dispatch", dispatch)

    assert await service._handle_command(f"frameos/frame/{frame.project_id + 1}/{frame.id}/press", b"render") is None
    assert await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id + 99}/press", b"render") is None
    assert await service._handle_command("frameos/frame/1/1/state", b"render") is None
    frame.archived = True
    await update_frame(db, redis, frame)
    assert await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id}/press", b"render") is None
    assert dispatch.calls == []


@pytest.mark.asyncio
async def test_a_refused_command_is_logged_on_the_frame_not_raised(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch(fail_with="Unable to reach frame")
    monkeypatch.setattr(service, "_dispatch", dispatch)

    await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id}/press", b"render")
    assert "failed: Unable to reach frame" in (await _last_log_line(db, frame.id) or "")

    await service._handle_command(f"frameos/frame/{frame.project_id}/{frame.id}/press", b"nonsense")
    assert "Home Assistant: Unknown button" in (await _last_log_line(db, frame.id) or "")
    assert len(dispatch.calls) == 1


@pytest.mark.asyncio
async def test_command_topic_from_an_automation(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    dispatch = RecordingDispatch()
    monkeypatch.setattr(service, "_dispatch", dispatch)
    topic = f"frameos/frame/{frame.project_id}/{frame.id}/command"

    await service._handle_command(topic, json.dumps({"scene": "Weather", "state": {"city": "Paris", "dark": "true"}}))
    await service._handle_command(topic, json.dumps({"event": "render"}))
    await service._handle_command(topic, json.dumps({"event": "reboot"}))  # refused: a button, never an event
    assert dispatch.calls == [
        (frame.id, "setCurrentScene", {"sceneId": "scene-2", "state": {"city": "Paris", "dark": True}}),
        (frame.id, "render", {}),
    ]
    # A scene switch from Home Assistant re-reads the showing scene's fields.
    assert frame.id in service._fields_refreshes


@pytest.mark.asyncio
async def test_display_power_follows_the_frames_own_log_lines(db, redis, service):
    frame = await _frame_with_scenes(db, redis, service)
    state_topic = discovery.frame_state_topic(frame.project_id, frame.id)

    async def log_event(event):
        await service._handle_log(
            {"type": "webhook", "frame_id": frame.id, "project_id": frame.project_id, "line": json.dumps({"event": event})}
        )
        return json.loads(service._mqtt.payload_for(state_topic))["display"]

    assert await log_event("event:turnOff") == "OFF"
    assert await log_event("event:toggleScreen") == "ON"
    assert await log_event("event:turnOn") == "ON"
    # The event itself is still forwarded like any other.
    event = json.loads(service._mqtt.payload_for(discovery.frame_event_topic(frame.project_id, frame.id)))
    assert event["event"] == "event:turnOn"


@pytest.mark.asyncio
async def test_the_scene_sensors_attributes_follow_the_showing_scene(db, redis, service, monkeypatch):
    frame = await _frame_with_scenes(db, redis, service)
    fields_topic = discovery.frame_fields_topic(frame.project_id, frame.id)
    # A device frame answers from the states cache the backend keeps for it.
    from app.api.frames import _frame_states_cache_key

    await redis.set(
        _frame_states_cache_key(frame.id),
        json.dumps({"sceneId": "scene-2", "states": {"scene-2": {"city": "Rome", "dark": True}}, "fetched_at": 1}),
    )
    await redis.set(f"frame:{frame.id}:active_scene", "scene-2")
    service._schedule_fields_refresh(frame.project_id, frame.id, delay=0)
    await asyncio.wait_for(service._fields_refreshes[frame.id], 5)
    assert json.loads(service._mqtt.payload_for(fields_topic)) == {
        "scene_id": "scene-2",
        "scene": "Weather",
        "fields": {"city": "Rome", "dark": True, "refreshInterval": 300},
    }

    # Another scene showing: its fields, with defaults where nothing was reported.
    await redis.set(f"frame:{frame.id}:active_scene", "scene-1")
    service._schedule_fields_refresh(frame.project_id, frame.id, delay=0)
    await asyncio.wait_for(service._fields_refreshes[frame.id], 5)
    assert json.loads(service._mqtt.payload_for(fields_topic)) == {
        "scene_id": "scene-1",
        "scene": "Clock",
        "fields": {"refreshInterval": 300},
    }

    # A state change or a scene change line schedules the refresh; a render does not.
    scheduled = []
    monkeypatch.setattr(service, "_schedule_fields_refresh", lambda project_id, frame_id, delay=1.0: scheduled.append(frame_id))
    for event in ("event:setSceneState", "render:done", "event:setCurrentScene", "render:sceneChange"):
        await service._handle_log(
            {"type": "webhook", "frame_id": frame.id, "project_id": frame.project_id, "line": json.dumps({"event": event})}
        )
    assert scheduled == [frame.id, frame.id, frame.id]


@pytest.mark.asyncio
async def test_scene_changes_rediscover_once(db, redis, service):
    frame = await _frame_with_scenes(db, redis, service)
    frame_dict = frame.to_dict()
    node = discovery.frame_node_id(frame.project_id, frame.id)
    await service._handle_broadcast("update_frame", frame_dict)
    select_topic = f"homeassistant/select/{node}/scene_select/config"
    assert json.loads(service._mqtt.payload_for(select_topic))["options"] == ["Clock", "Weather", "Photos"]
    # Whatever the scenes hold, the device has its twelve entities and no more.
    assert len([topic for topic in service._mqtt.topics() if topic.startswith("homeassistant/")]) == 12

    # The same frame again (a status change, a log): discovery is not resent.
    service._mqtt.messages.clear()
    await service._handle_broadcast("update_frame", frame_dict)
    assert all(not topic.startswith("homeassistant/") for topic in service._mqtt.topics())
    assert discovery.frame_state_topic(frame.project_id, frame.id) in service._mqtt.topics()

    # Weather removed: the select shrinks, nothing is left behind to retract.
    frame.scenes = [scene for scene in frame.scenes if scene["id"] != "scene-2"]
    db.commit()
    service._mqtt.messages.clear()
    await service._handle_broadcast("update_frame", {"id": frame.id, "project_id": frame.project_id})
    assert json.loads(service._mqtt.payload_for(select_topic))["options"] == ["Clock", "Photos"]
    assert len([topic for topic in service._mqtt.topics() if topic.startswith("homeassistant/")]) == 12
