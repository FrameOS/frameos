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
        for message_topic, payload, _retain in self.messages:
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
    assert discovery.frame_state_topic(project_id, archived.id) not in topics

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
