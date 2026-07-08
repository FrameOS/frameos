import asyncio
import json
import uuid
from http import HTTPStatus
from types import SimpleNamespace

from arq import ArqRedis as Redis
from fastapi import Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.ha import HA_SYNC_CHANNEL, HA_SYNC_REQUEST_KEY
from app.models.settings import get_settings_dict, Settings
from app.redis import get_redis
from app.schemas.settings import SettingsResponse, SettingsUpdateRequest
from app.tenancy import current_project_id
from app.utils.build_environment import selected_build_environment_provider
from app.utils.build_executor import create_build_executor
from app.utils.build_host import BuildHostConfig
from app.utils.modal_sandbox import ModalSandboxConfig
from app.utils.posthog import initialize_posthog
from . import api_project

@api_project.get("/settings", response_model=SettingsResponse)
async def get_settings(db: Session = Depends(get_db)):
    return get_settings_dict(db, project_id=current_project_id())

@api_project.post("/settings", response_model=SettingsResponse)
async def set_settings(data: SettingsUpdateRequest, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    project_id = current_project_id()
    payload = data.to_dict()
    if not payload:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="No JSON payload received")

    try:
        current_settings = get_settings_dict(db, project_id=project_id)
        merged_settings = {**current_settings, **payload}
        provider = selected_build_environment_provider(merged_settings)
        if isinstance(payload.get("buildHost"), dict):
            payload["buildHost"] = {**payload["buildHost"], "enabled": provider == "buildHost"}
        if isinstance(payload.get("modalSandbox"), dict):
            payload["modalSandbox"] = {**payload["modalSandbox"], "enabled": provider == "modal"}

        for key, value in payload.items():
            if value != current_settings.get(key):
                setting = db.query(Settings).filter_by(project_id=project_id, key=key).first()
                if setting:
                    setting.value = value
                else:
                    new_setting = Settings(project_id=project_id, key=key, value=value)
                    db.add(new_setting)
        db.commit()
    except SQLAlchemyError:
        raise HTTPException(status_code=500, detail="Database error")

    updated_settings = get_settings_dict(db, project_id=project_id)
    if "posthog" in payload:
        initialize_posthog(updated_settings, project_id=project_id)
    if "homeAssistant" in payload:
        # Wake the sync service (it lives in the worker process) so it picks up
        # the new configuration and republishes discovery data.
        await redis.publish(HA_SYNC_CHANNEL, json.dumps({"event": "settings_changed", "project_id": project_id}))
    return updated_settings


HA_SYNC_REPLY_TIMEOUT_SECONDS = 30.0
HA_SYNC_LOG_HINT = (
    "Check the FrameOS logs for 'Home Assistant sync' lines: as an add-on open "
    "Settings → Add-ons → FrameOS → Log in Home Assistant, otherwise run `docker logs` "
    "on the FrameOS container."
)


async def _next_json_pubsub_message(pubsub, timeout: float) -> dict | None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while (remaining := deadline - loop.time()) > 0:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=min(remaining, 1.0))
        if not message or message.get("type") != "message":
            continue
        data = message.get("data")
        try:
            parsed = json.loads(data.decode() if isinstance(data, bytes) else data)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _home_assistant_sync_response(reply: dict | None, project_id: int) -> dict:
    if reply is None:
        raise HTTPException(
            status_code=HTTPStatus.GATEWAY_TIMEOUT,
            detail=(
                "The Home Assistant sync service did not respond within "
                f"{HA_SYNC_REPLY_TIMEOUT_SECONDS:.0f} seconds. It runs inside the FrameOS "
                f"background worker, which may not be running. {HA_SYNC_LOG_HINT}"
            ),
        )
    if reply.get("error"):
        # The sync service's error is already specific and actionable; the
        # generic "check the logs" hint would only bury it.
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Home Assistant sync failed: {reply['error']}",
        )
    mqtt = reply.get("mqtt")
    if not isinstance(mqtt, dict):
        # MQTT is optional ("leave empty to skip MQTT"), so a missing broker is a
        # warning as long as events still reach the Home Assistant event bus.
        event_bus_works = bool(reply.get("supervisor")) or project_id in (reply.get("event_bus_project_ids") or [])
        if not event_bus_works:
            raise HTTPException(
                status_code=HTTPStatus.BAD_GATEWAY,
                detail=(
                    "Nothing was synced: no MQTT broker and no Home Assistant connection are "
                    "configured. Fill in the Home Assistant URL and access token (for events), "
                    "and the MQTT username and password (to share frames as devices), then sync again."
                ),
            )
        how_to_add_broker = (
            "Install and start the 'Mosquitto broker' add-on in Home Assistant"
            if reply.get("supervisor")
            else "Fill in the MQTT username and password under Settings → Home Assistant"
        )
        return {
            "ok": True,
            "warning": True,
            "message": (
                "Settings saved, and frame events are forwarded to the Home Assistant event bus. "
                "However, no MQTT broker is configured, so frames do not appear as devices in "
                f"Home Assistant. {how_to_add_broker} and sync again to share them as devices."
            ),
            "frames_shared": 0,
            "mqtt": None,
        }

    count = int((reply.get("frames_shared") or {}).get(str(project_id)) or 0)
    message = (
        f"Shared {count} frame{'s' if count != 1 else ''} with Home Assistant via MQTT "
        f"({mqtt.get('host')}:{mqtt.get('port')})."
    )
    if count:
        message += " Look for FrameOS devices under Settings → Devices & Services → MQTT in Home Assistant."
    else:
        message += " There are no unarchived frames to share yet."
    if not reply.get("supervisor") and project_id not in (reply.get("event_bus_project_ids") or []):
        message += (
            " Note: frame events are not forwarded to the Home Assistant event bus until the "
            "Home Assistant URL and access token are set."
        )
    return {"ok": True, "message": message, "frames_shared": count, "mqtt": mqtt}


@api_project.post("/settings/home_assistant/sync")
async def home_assistant_sync_now(db: Session = Depends(get_db), redis: Redis = Depends(get_redis)):
    project_id = current_project_id()
    settings = get_settings_dict(db, project_id=project_id)
    home_assistant = settings.get("homeAssistant") or {}
    if not isinstance(home_assistant, dict) or not home_assistant.get("syncEnabled"):
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Enable 'Share frames with Home Assistant' first",
        )

    # Leave the request in Redis (the sync service claims it even when it is
    # between reconnects while the nudge below fires), then wait for its answer.
    reply_channel = f"ha_sync:reply:{uuid.uuid4().hex}"
    pubsub = redis.pubsub()
    await pubsub.subscribe(reply_channel)
    try:
        await redis.set(
            HA_SYNC_REQUEST_KEY,
            json.dumps({"reply_channel": reply_channel, "project_id": project_id}),
            ex=60,
        )
        await redis.publish(HA_SYNC_CHANNEL, json.dumps({"event": "sync_now", "project_id": project_id}))
        reply = await _next_json_pubsub_message(pubsub, HA_SYNC_REPLY_TIMEOUT_SECONDS)
    finally:
        try:
            await pubsub.unsubscribe(reply_channel)
            await pubsub.close()
        except Exception:
            pass

    return _home_assistant_sync_response(reply, project_id)


@api_project.post("/settings/test_build_host")
async def test_build_host(data: SettingsUpdateRequest):
    payload = data.to_dict()
    raw_build_host_settings = payload.get("buildHost") if isinstance(payload, dict) else None
    build_host_config = BuildHostConfig.from_settings(
        {**raw_build_host_settings, "enabled": True} if isinstance(raw_build_host_settings, dict) else raw_build_host_settings
    )
    if build_host_config is None:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Select build host via SSH and enter a host, user, and private SSH key first",
    )

    try:
        async with create_build_executor(
            build_host_config,
            db=None,
            redis=None,
            frame=SimpleNamespace(id=0),
            workspace_prefix="frameos-build-host-test-",
        ) as executor:
            status, out, err = await executor.run(
                "echo frameos-build-host-ok && command -v docker >/dev/null && docker buildx version >/dev/null",
                log_command=False,
                log_output=False,
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Build host connection failed: {exc}") from exc

    if status != 0:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=err or out or "Build host is missing Docker or the Docker Buildx plugin",
        )

    return {"ok": True, "output": (out or "").strip()}


@api_project.post("/settings/test_modal_sandbox")
async def test_modal_sandbox(data: SettingsUpdateRequest):
    payload = data.to_dict()
    raw_modal_settings = payload.get("modalSandbox") if isinstance(payload, dict) else None
    modal_config = ModalSandboxConfig.from_settings(raw_modal_settings)
    if modal_config is None:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Select Modal sandboxes and enter a token ID and token secret first",
    )

    try:
        async with create_build_executor(
            modal_config,
            db=None,
            redis=None,
            frame=SimpleNamespace(id=0),
        ) as executor:
            status, out, err = await executor.run(
                "command -v nimble && nimble --version >/dev/null && echo frameos-modal-sandbox-ok",
                log_command=False,
                log_output=False,
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Modal sandbox test failed: {exc}") from exc

    if status != 0:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=err or out or "Modal sandbox image is missing the FrameOS Nim toolchain",
        )

    return {"ok": True, "output": (out or "").strip()}
