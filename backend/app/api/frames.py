from __future__ import annotations

# stdlib ---------------------------------------------------------------------
import asyncio
import copy
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
import contextlib
import aiofiles
import asyncssh
import gzip
import hashlib
import io
import json
import mimetypes
import os
import re
import shlex
import shutil
import sys
import tempfile
import time
import uuid
import zipfile
from tempfile import NamedTemporaryFile
from typing import Any, Awaitable, Optional, Tuple, cast
from types import SimpleNamespace
from urllib.parse import quote

# third-party ---------------------------------------------------------------
import httpx
from fastapi import (
    Depends,
    File,
    Form,
    HTTPException,
    Header,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

# local ---------------------------------------------------------------------
from app.database import SessionLocal, get_db
from arq import ArqRedis as Redis
from app.models.frame import (
    Frame,
    compact_timezone_updater,
    new_frame,
    delete_frame,
    normalize_frame_admin_auth,
    normalize_error_behavior,
    normalize_https_proxy,
    refresh_tls_certificate_validity_dates,
    update_frame,
)
from app.models.log import FRAME_ACTIVITY_LOG_TYPES, Log, new_log as log
from app.models.metrics import Metrics
from app.codegen.scene_nim import write_scene_nim
from app.utils.ssh_utils import (
    get_ssh_connection,
    exec_command,
    remove_ssh_connection,
)
from app.utils.image import render_line_of_text_png
from app.schemas.frames import (
    FramesListResponse,
    FrameResponse,
    FrameLogsResponse,
    FrameMetricsResponse,
    FrameStateResponse,
    FrameUploadedScenesResponse,
    FrameAssetsResponse,
    FrameCreateRequest,
    FrameUpdateRequest,
    FramePingResponse,
    FrameSSHKeysUpdateRequest,
    FrameSetNextSceneRequest,
    FrameSyncApplyRequest,
)
from app.api.auth import get_current_user_from_request
from app.config import config
from app.utils.network import is_safe_host
from app.utils.remote_exec import (
    RemoteTransport,
    normalize_remote_transport,
    upload_file,
    delete_path,
    rename_path,
    make_dir,
    run_command,
    _use_remote,
)
from app.utils.frame_http import (
    _build_frame_path,
    _build_frame_url,
    _auth_headers,
    _fetch_frame_http_bytes,
    _frame_scheme_port,
    _httpx_verify,
)
from app.tasks.utils import find_nim_v2
from app.tasks._frame_deployer import FrameDeployer
from app.tasks.frame_deploy_workflow import FrameDeployWorkflow
from app.redis import close_redis_connection, create_redis_connection, get_redis
from app.websockets import publish_message
from app.ws.remote_ws import (
    http_get_on_frame,
    number_of_connections_for_frame,
    file_md5_on_frame,
    file_read_on_frame,
    assets_list_on_frame,
    exec_shell_on_frame,
)
from app.models.assets import copy_custom_fonts_to_local_source_folder
from app.models.settings import get_settings_dict
from app.utils.build_environment import selected_build_environment_provider
from app.utils.build_host import get_build_executor_config
from app.utils.build_executor import build_environment_requires_executor_config
from app.utils.ssh_key_utils import default_ssh_key_ids
from app.utils.timezone import frame_timezone, normalize_timezone, stored_timezone
from app.utils.tls import generate_frame_tls_material, parse_certificate_not_valid_after
from app.utils.versions import current_frameos_version
from app.utils.ssh_authorized_keys import _install_authorized_keys, resolve_authorized_keys_update
from app.tasks.binary_builder import FrameBinaryBuilder
from app.tasks.embedded_firmware import (
    ensure_embedded_frame_defaults,
    embedded_flash_size_for_frame,
    embedded_ota_supported_for_frame,
    embedded_toolchain_available,
    latest_embedded_firmware,
    normalize_embedded_platform,
    refresh_embedded_firmware_status,
    request_or_queue_embedded_firmware_ota,
    start_embedded_firmware,
    with_embedded_firmware_layout,
)
from app.tasks.buildroot_image import (
    buildroot_sd_image_no_build_environment_message,
    buildroot_sd_image_config_fingerprint,
    can_use_precompiled_buildroot_sd_image,
    clear_buildroot_sd_image,
    ensure_buildroot_frame_defaults,
    latest_buildroot_sd_image,
    normalize_buildroot_platform,
    refresh_buildroot_sd_image_status,
    resolve_buildroot_base_entry,
    start_buildroot_sd_image,
    validate_buildroot_network,
    validate_buildroot_wifi_credentials,
)
from app.codegen.drivers_nim import frame_compilation_mode
from app.api.project_scope import project_get_or_404
from app.utils.local_exec import exec_local_command
from app.utils.jwt_tokens import validate_scoped_token
from app.tenancy import current_project_id, get_user_project
from . import api_project, api_open

REMOTE_TASK_TRANSPORTS = {"auto", "remote", "agent", "ssh"}


def _remote_task_transport(transport: str) -> RemoteTransport:
    if transport not in REMOTE_TASK_TRANSPORTS:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid remote task transport")
    return normalize_remote_transport(transport)

FRAME_ASSETS_CACHE_REFRESH_AFTER_SECONDS = 20
FRAME_ASSETS_CACHE_RETRY_AFTER_SECONDS = 2
FRAME_ASSETS_CACHE_LOCK_SECONDS = 60
FRAME_ASSETS_CACHE_TTL_SECONDS = 86400 * 30
FRAME_STATES_CACHE_REFRESH_AFTER_SECONDS = 5
FRAME_STATES_CACHE_RETRY_AFTER_SECONDS = 5
FRAME_STATES_CACHE_FAILURE_RETRY_AFTER_SECONDS = 60
FRAME_STATES_CACHE_LOCK_SECONDS = 30
FRAME_STATES_CACHE_TTL_SECONDS = 86400 * 30
FRAME_IMAGE_REFRESH_LOCK_SECONDS = 65
FRAME_IMAGE_REFRESH_WAIT_SECONDS = 2.0
FRAME_IMAGE_PLACEHOLDER_HEADERS = {"X-FrameOS-Image-State": "placeholder"}
FRAME_SYNC_IMAGE_HEADER_NAMES = (
    "X-FrameOS-Sync-Changed",
    "X-FrameOS-Sync-Revision",
    "X-FrameOS-Deployed-Revision",
    "X-FrameOS-Frame-Config-Modified-At",
    "X-FrameOS-Scenes-Modified-At",
    "X-FrameOS-Last-Successful-Deploy-At",
    "X-FrameOS-Sync-Checked-At",
)


def _not_found():
    raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")


def _project_frame(db: Session, frame_id: int) -> Frame:
    return project_get_or_404(db, Frame, frame_id, detail="Frame not found")


async def _public_project_frame(
    *,
    project_id: int,
    frame_id: int,
    request: Request,
    db: Session,
    token: str | None = None,
    authorization: str | None = None,
) -> Frame:
    if config.HASSIO_RUN_MODE != "ingress":
        user = await get_current_user_from_request(request, db, authorization)
        if user is not None and get_user_project(db, user, project_id) is not None:
            pass
        elif token:
            validate_scoped_token(token, expected_subject=f"project={project_id}:frame={frame_id}")
        else:
            raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Unauthorized")

    frame = db.query(Frame).filter_by(project_id=project_id, id=frame_id).first()
    if frame is None:
        _not_found()
    return frame


def _bad_request(msg: str):
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=msg)


def _task_id_param(task_id: str | None) -> str | None:
    if task_id is None:
        return None
    value = task_id.strip()
    if not value:
        return None
    if len(value) > 120 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
        _bad_request("Invalid task_id")
    return value


def _frame_assets_cache_key(frame_id: int, assets_path: str) -> str:
    path_hash = hashlib.sha1(assets_path.encode()).hexdigest()
    return f"frame:{frame_id}:assets:list:{path_hash}"


def _frame_assets_cache_lock_key(frame_id: int, assets_path: str) -> str:
    path_hash = hashlib.sha1(assets_path.encode()).hexdigest()
    return f"frame:{frame_id}:assets:list:{path_hash}:refreshing"


def _frame_assets_cache_invalidated_key(frame_id: int, assets_path: str) -> str:
    path_hash = hashlib.sha1(assets_path.encode()).hexdigest()
    return f"frame:{frame_id}:assets:list:{path_hash}:invalidated"


def _frame_states_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:states"


def _frame_state_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:state"


def _frame_uploaded_scenes_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:uploaded_scenes"


def _frame_image_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:image"


def _frame_sync_hint_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:sync_hint"


UPLOADED_SCENE_PREFIX = "uploaded/"


def _configured_scene_ids(frame: Frame) -> set[str]:
    scene_ids: set[str] = set()
    for scene in frame.scenes or []:
        scene_id = scene.get("id") if isinstance(scene, dict) else None
        if isinstance(scene_id, str):
            scene_ids.add(scene_id)
    return scene_ids


def _scene_image_scene_id_for_frame(frame: Frame, scene_id: str) -> str:
    if not scene_id.startswith(UPLOADED_SCENE_PREFIX):
        return scene_id

    original_scene_id = scene_id[len(UPLOADED_SCENE_PREFIX) :]
    configured_scene_ids = _configured_scene_ids(frame)
    if scene_id in configured_scene_ids and original_scene_id not in configured_scene_ids:
        return scene_id
    if original_scene_id in configured_scene_ids:
        return original_scene_id

    return original_scene_id


def _coerce_frame_image_to_png(body: bytes, headers: dict[str, str]) -> bytes:
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in ("image/bmp", "image/x-ms-bmp"):
        return body

    from PIL import Image

    with Image.open(io.BytesIO(body)) as image:
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()


def _frame_states_cache_lock_key(frame_id: int) -> str:
    return f"frame:{frame_id}:states:refreshing"


def _frame_states_cache_invalidated_key(frame_id: int) -> str:
    return f"frame:{frame_id}:states:invalidated"


def _frame_image_refresh_lock_key(frame_id: int) -> str:
    return f"frame:{frame_id}:image:refreshing"


async def _read_frame_assets_cache(redis: Redis, cache_key: str) -> dict[str, Any] | None:
    cached = await redis.get(cache_key)
    if not cached:
        return None
    try:
        payload = json.loads(cached.decode() if isinstance(cached, bytes) else cached)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("assets"), list):
        return None
    return payload


async def _write_frame_assets_cache(
    redis: Redis,
    cache_key: str,
    assets: list[dict[str, Any]],
    *,
    fetched_at: float | None = None,
) -> float:
    cache_time = fetched_at if fetched_at is not None else time.time()
    await redis.set(
        cache_key,
        json.dumps({"assets": assets, "fetched_at": cache_time}).encode(),
        ex=FRAME_ASSETS_CACHE_TTL_SECONDS,
    )
    return cache_time


async def _invalidate_frame_assets_cache(redis: Redis, frame: Frame, assets_path: str) -> None:
    await redis.set(
        _frame_assets_cache_invalidated_key(frame.id, assets_path),
        str(time.time()),
        ex=FRAME_ASSETS_CACHE_TTL_SECONDS,
    )
    await redis.delete(
        _frame_assets_cache_key(frame.id, assets_path),
        _frame_assets_cache_lock_key(frame.id, assets_path),
    )


def _normalise_frame_states_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"sceneId": "", "states": {}}

    scene_id = payload.get("sceneId")
    if scene_id is None:
        scene_id = ""
    elif not isinstance(scene_id, str):
        scene_id = str(scene_id)

    states = payload.get("states")
    if not isinstance(states, dict):
        state = payload.get("state")
        states = {scene_id: state} if scene_id and isinstance(state, dict) else {}

    return {"sceneId": scene_id, "states": states}


async def _read_frame_states_cache(redis: Redis, cache_key: str) -> dict[str, Any] | None:
    cached = await redis.get(cache_key)
    if not cached:
        return None
    try:
        payload = json.loads(cached.decode() if isinstance(cached, bytes) else cached)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("states"), dict):
        return None
    return payload


async def _write_frame_states_cache(
    redis: Redis,
    cache_key: str,
    state_record: dict[str, Any],
    *,
    fetched_at: float | None = None,
) -> float:
    cache_time = fetched_at if fetched_at is not None else time.time()
    payload = {**_normalise_frame_states_payload(state_record), "fetched_at": cache_time}
    if isinstance(state_record.get("error"), str):
        payload["error"] = _truncate_text(state_record["error"])
    await redis.set(cache_key, json.dumps(payload).encode(), ex=FRAME_STATES_CACHE_TTL_SECONDS)
    return cache_time


async def _mark_frame_states_cache_stale(
    redis: Redis,
    frame: Frame,
    *,
    scene_id: str | None = None,
) -> None:
    cache_key = _frame_states_cache_key(frame.id)
    if scene_id:
        await redis.set(f"frame:{frame.id}:active_scene", scene_id)
    cached = await _read_frame_states_cache(redis, cache_key)
    if cached is not None:
        payload = _normalise_frame_states_payload(cached)
        if scene_id:
            payload["sceneId"] = scene_id
        await _write_frame_states_cache(redis, cache_key, payload, fetched_at=0)
    await redis.set(
        _frame_states_cache_invalidated_key(frame.id),
        str(time.time()),
        ex=FRAME_STATES_CACHE_TTL_SECONDS,
    )


def _serialize_datetime(value: Optional[datetime]) -> Optional[str]:
    if not value:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat()


FRAME_SYNC_FRAME_KEYS = tuple(
    key
    for key in FrameUpdateRequest.model_fields.keys()
    if key
    not in {
        "archived",
        "buildroot",
        "embedded",
        "frame_access",
        "frame_access_key",
        "frame_host",
        "frame_port",
        "log_to_file",
        "next_action",
        "rpios",
        "scenes",
        "server_api_key",
        "ssh_keys",
        "ssh_pass",
        "ssh_port",
        "ssh_user",
        "terminal_history",
        "timezone_updater",
    }
)
FRAME_SYNC_NETWORK_KEYS = {
    "networkCheck",
    "networkCheckTimeoutSeconds",
    "networkCheckUrl",
    "wifiHotspot",
    "wifiHotspotSsid",
    "wifiHotspotPassword",
    "wifiHotspotTimeoutSeconds",
}
FRAME_SYNC_AGENT_KEYS = {
    "agentEnabled",
    "agentRunCommands",
    "agentSharedSecret",
}
FRAME_SYNC_SECRET_KEYS = {
    "frame_access_key",
    "server_api_key",
    "ssh_pass",
}
FRAME_SYNC_SECRET_PATH_PARTS = {
    "pass",
    "password",
    "server_key",
    "serverKey",
    "client_ca",
    "clientCa",
    "private_key",
    "privateKey",
}
FRAME_SYNC_LABELS = {
    "frame_json": "frame.json",
    "scenes_json": "scenes.json",
    "frame_admin_auth": "Frame admin auth",
    "https_proxy": "HTTPS proxy",
    "server_send_logs": "Send logs to backend",
    "device_config": "Device config",
    "timezone_updater": "Timezone updater",
    "metrics_interval": "Metrics interval",
    "max_http_response_bytes": "HTTP response limit",
    "scaling_mode": "Scaling mode",
    "background_color": "Background color",
    "log_to_file": "Log file",
    "assets_path": "Assets path",
    "save_assets": "Save assets",
    "upload_fonts": "Upload fonts",
    "control_code": "Control code",
    "gpio_buttons": "GPIO buttons",
    "error_behavior": "Error behavior",
}


def _sync_label(key: str) -> str:
    return FRAME_SYNC_LABELS.get(key, key.replace("_", " ").replace("-", " ").title())


def _sync_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on", "enabled"}:
            return True
        if normalized in {"false", "0", "no", "off", "disabled", ""}:
            return False
    if value is None:
        return default
    return bool(value)


def _sync_number(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        candidate = value.strip()
        if re.fullmatch(r"-?\d+", candidate):
            try:
                return int(candidate)
            except ValueError:
                return value
        if re.fullmatch(r"-?\d+\.\d+", candidate):
            try:
                return float(candidate)
            except ValueError:
                return value
    return value


def _sync_prune_empty(value: Any) -> Any:
    value = _jsonable(value)
    if isinstance(value, dict):
        compact = {
            str(key): _sync_prune_empty(item)
            for key, item in value.items()
        }
        return {key: item for key, item in compact.items() if item not in (None, "", [], {})}
    if isinstance(value, list):
        compact = [_sync_prune_empty(item) for item in value]
        return [item for item in compact if item not in (None, "", [], {})]
    if value in (None, ""):
        return None
    return _sync_number(value)


def _sync_compact_mapping(value: Any, allowed_keys: set[str] | None = None) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    source = {
        str(key): item
        for key, item in value.items()
        if allowed_keys is None or str(key) in allowed_keys
    }
    compact = _sync_prune_empty(source)
    return compact if isinstance(compact, dict) and compact else None


def _sync_https_proxy(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if not _sync_bool(value.get("enable"), False):
        return None
    certs = value.get("certs") if isinstance(value.get("certs"), dict) else {}
    proxy = {
        "enable": True,
        "port": _sync_number(value.get("port") or 8443),
        "expose_only_port": _sync_bool(value.get("expose_only_port"), True),
        "certs": {
            "server": certs.get("server"),
            "server_key": certs.get("server_key"),
        },
    }
    return _sync_prune_empty(proxy)


def _sync_agent(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not _sync_bool(value.get("agentEnabled"), False):
        return None
    return _sync_compact_mapping(value, FRAME_SYNC_AGENT_KEYS)


def _sync_device_config(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    config = dict(value)
    for key in ("queryParam", "uploadMethod"):
        config.pop(key, None)
    for key in ("partial",):
        if _sync_bool(config.get(key), False) is False:
            config.pop(key, None)
    for key in ("partialMaxAreaPercent", "partialMaxRefreshesBeforeFull", "vcom"):
        if _sync_number(config.get(key)) in (None, "", 0, 0.0):
            config.pop(key, None)
    return _sync_compact_mapping(config)


def _sync_reboot(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if not _sync_bool(value.get("enabled"), False):
        return None
    return _sync_compact_mapping(value)


def _sync_control_code(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not _sync_bool(value.get("enabled"), False):
        return None
    return _sync_compact_mapping(value)


def _sync_schedule(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    events = value.get("events")
    if not isinstance(events, list) or not events:
        return None
    return _sync_compact_mapping({"events": events})


def _sync_gpio_buttons(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    buttons: list[dict[str, Any]] = []
    for raw_button in value:
        if not isinstance(raw_button, dict):
            continue
        pin = _sync_number(raw_button.get("pin"))
        if not isinstance(pin, int) or pin <= 0:
            continue
        button: dict[str, Any] = {"pin": pin}
        label = str(raw_button.get("label") or "").strip()
        if label and label != f"Pin {pin}":
            button["label"] = label
        buttons.append(button)
    return buttons or None


def _sync_mountpoints(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not _sync_bool(value.get("enabled"), False):
        return None
    return _sync_compact_mapping(value)


def _sync_error_behavior(value: Any) -> dict[str, Any] | None:
    normalized = normalize_error_behavior(value)
    default = normalize_error_behavior(None)
    return None if _sync_values_equal(normalized, default) else normalized


def _sync_frame_value(key: str, value: Any) -> Any:
    if key == "https_proxy":
        return _sync_https_proxy(value)
    if key == "network":
        return _sync_compact_mapping(value, FRAME_SYNC_NETWORK_KEYS)
    if key == "agent":
        return _sync_agent(value)
    if key == "device_config":
        return _sync_device_config(value)
    if key == "reboot":
        return _sync_reboot(value)
    if key == "control_code":
        return _sync_control_code(value)
    if key == "schedule":
        return _sync_schedule(value)
    if key == "gpio_buttons":
        return _sync_gpio_buttons(value)
    if key == "mountpoints":
        return _sync_mountpoints(value)
    if key == "error_behavior":
        return _sync_error_behavior(value)
    if key == "palette":
        return _sync_compact_mapping(value)
    if key == "frame_admin_auth":
        return _sync_prune_empty(normalize_frame_admin_auth(value))
    return _sync_prune_empty(value)


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return _serialize_datetime(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _sync_compare_value(value: Any) -> Any:
    return json.loads(json.dumps(_jsonable(value), sort_keys=True, separators=(",", ":"), default=str))


def _sync_values_equal(first: Any, second: Any) -> bool:
    return _sync_compare_value(first) == _sync_compare_value(second)


def _sync_path_is_secret(path: str) -> bool:
    parts = {part for part in re.split(r"[.\[\]]+", path) if part}
    return bool(parts & FRAME_SYNC_SECRET_PATH_PARTS)


def _sync_summary(value: Any, *, path: str = "") -> str:
    if path in FRAME_SYNC_SECRET_KEYS or _sync_path_is_secret(path):
        return "Configured" if value not in (None, "", [], {}) else "Not set"
    if value is None:
        return "Not set"
    if value == "":
        return "Empty"
    if isinstance(value, bool):
        return "Enabled" if value else "Disabled"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value if len(value) <= 180 else f"{value[:177]}..."
    if isinstance(value, list):
        return f"{len(value)} item{'s' if len(value) != 1 else ''}"
    if isinstance(value, dict):
        return f"{len(value)} field{'s' if len(value) != 1 else ''}"
    return str(value)


def _scene_title(scene: Any) -> str:
    if not isinstance(scene, dict):
        return "Unknown scene"
    return str(scene.get("name") or scene.get("id") or "Untitled scene")


def _scene_summary(scene: Any) -> str:
    if not isinstance(scene, dict):
        return _sync_summary(scene)
    nodes = scene.get("nodes")
    edges = scene.get("edges")
    node_count = len(nodes) if isinstance(nodes, list) else 0
    edge_count = len(edges) if isinstance(edges, list) else 0
    return f"{_scene_title(scene)} ({node_count} nodes, {edge_count} edges)"


def _scene_node_label(node: Any) -> str:
    if not isinstance(node, dict):
        return "Unknown node"
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    return str(data.get("keyword") or data.get("label") or node.get("type") or node.get("id") or "Unknown node")


def _scene_node_compare_value(node: Any) -> dict[str, Any]:
    if not isinstance(node, dict):
        return {}
    return _sync_prune_empty(
        {
            "type": node.get("type"),
            "data": node.get("data"),
        }
    ) or {}


def _scene_nodes_by_id(scene: Any) -> dict[str, Any]:
    if not isinstance(scene, dict) or not isinstance(scene.get("nodes"), list):
        return {}
    nodes: dict[str, Any] = {}
    for index, node in enumerate(scene["nodes"]):
        if isinstance(node, dict):
            nodes[str(node.get("id") or f"index:{index}")] = node
    return nodes


def _scene_edge_key(edge: Any, index: int) -> str:
    if not isinstance(edge, dict):
        return f"index:{index}"
    parts = [
        str(edge.get("source") or ""),
        str(edge.get("sourceHandle") or ""),
        str(edge.get("target") or ""),
        str(edge.get("targetHandle") or ""),
        str(edge.get("type") or ""),
    ]
    return "|".join(parts) or str(edge.get("id") or f"index:{index}")


def _scene_edge_summary(edge: Any) -> str:
    if not isinstance(edge, dict):
        return "Unknown connection"
    source = str(edge.get("source") or "?")
    target = str(edge.get("target") or "?")
    source_handle = str(edge.get("sourceHandle") or "")
    target_handle = str(edge.get("targetHandle") or "")
    return f"{source}{':' + source_handle if source_handle else ''} -> {target}{':' + target_handle if target_handle else ''}"


def _scene_edge_compare_value(edge: Any) -> dict[str, Any]:
    if not isinstance(edge, dict):
        return {}
    return _sync_prune_empty(
        {
            "source": edge.get("source"),
            "sourceHandle": edge.get("sourceHandle"),
            "target": edge.get("target"),
            "targetHandle": edge.get("targetHandle"),
            "type": edge.get("type"),
            "data": edge.get("data"),
        }
    ) or {}


def _scene_clean_node_detail_path(path: str, label: str) -> str:
    prefix = f"Node {label}."
    if path.startswith(f"{prefix}data.config."):
        return f"Node {label} config.{path[len(f'{prefix}data.config.'):]}"
    if path.startswith(f"{prefix}data."):
        return f"Node {label} {path[len(f'{prefix}data.'):]}"
    return path


def _scene_edges_by_key(scene: Any) -> dict[str, Any]:
    if not isinstance(scene, dict) or not isinstance(scene.get("edges"), list):
        return {}
    return {
        _scene_edge_key(edge, index): edge
        for index, edge in enumerate(scene["edges"])
    }


def _scene_compare_value(scene: Any) -> dict[str, Any]:
    if not isinstance(scene, dict):
        return {}
    return {
        "name": _sync_prune_empty(scene.get("name")),
        "settings": _sync_prune_empty(scene.get("settings")) or {},
        "fields": _sync_prune_empty(scene.get("fields")) or [],
        "apps": _sync_prune_empty(scene.get("apps")) or {},
        "nodes": {
            key: _scene_node_compare_value(node)
            for key, node in _scene_nodes_by_id(scene).items()
        },
        "edges": {
            key: _scene_edge_compare_value(edge)
            for key, edge in _scene_edges_by_key(scene).items()
        },
    }


def _scene_diff_details(backend_scene: Any, frame_scene: Any, *, limit: int = 12) -> list[dict[str, Any]]:
    if limit <= 0:
        return []

    backend_compare = _scene_compare_value(backend_scene)
    frame_compare = _scene_compare_value(frame_scene)
    if _sync_values_equal(backend_compare, frame_compare):
        return []

    details: list[dict[str, Any]] = []

    for key, label in (("name", "Name"), ("settings", "Settings"), ("fields", "Fields"), ("apps", "Apps")):
        if len(details) >= limit:
            return details
        if _sync_values_equal(backend_compare.get(key), frame_compare.get(key)):
            continue
        details.extend(
            _json_diff_details(
                backend_compare.get(key),
                frame_compare.get(key),
                path=label,
                limit=limit - len(details),
            )
        )

    backend_nodes = _scene_nodes_by_id(backend_scene)
    frame_nodes = _scene_nodes_by_id(frame_scene)
    for node_id in sorted(set(backend_nodes.keys()) | set(frame_nodes.keys())):
        if len(details) >= limit:
            return details
        backend_node = backend_nodes.get(node_id)
        frame_node = frame_nodes.get(node_id)
        label = _scene_node_label(frame_node or backend_node)
        if backend_node is None:
            details.append(
                {
                    "path": f"Node added: {label}",
                    "backend": "Missing",
                    "frame": _sync_summary(_scene_node_compare_value(frame_node)),
                }
            )
            continue
        if frame_node is None:
            details.append(
                {
                    "path": f"Node removed: {label}",
                    "backend": _sync_summary(_scene_node_compare_value(backend_node)),
                    "frame": "Missing",
                }
            )
            continue
        backend_node_value = _scene_node_compare_value(backend_node)
        frame_node_value = _scene_node_compare_value(frame_node)
        if _sync_values_equal(backend_node_value, frame_node_value):
            continue
        node_details = _json_diff_details(
            backend_node_value,
            frame_node_value,
            path=f"Node {label}",
            limit=limit - len(details),
        )
        details.extend({**detail, "path": _scene_clean_node_detail_path(detail["path"], label)} for detail in node_details)

    backend_edges = _scene_edges_by_key(backend_scene)
    frame_edges = _scene_edges_by_key(frame_scene)
    for edge_key in sorted(set(backend_edges.keys()) | set(frame_edges.keys())):
        if len(details) >= limit:
            return details
        backend_edge = backend_edges.get(edge_key)
        frame_edge = frame_edges.get(edge_key)
        label = _scene_edge_summary(frame_edge or backend_edge)
        if backend_edge is None:
            details.append(
                {
                    "path": f"Connection added: {label}",
                    "backend": "Missing",
                    "frame": _sync_summary(_scene_edge_compare_value(frame_edge)),
                }
            )
            continue
        if frame_edge is None:
            details.append(
                {
                    "path": f"Connection removed: {label}",
                    "backend": _sync_summary(_scene_edge_compare_value(backend_edge)),
                    "frame": "Missing",
                }
            )
            continue
        backend_edge_value = _scene_edge_compare_value(backend_edge)
        frame_edge_value = _scene_edge_compare_value(frame_edge)
        if _sync_values_equal(backend_edge_value, frame_edge_value):
            continue
        details.extend(
            _json_diff_details(
                backend_edge_value,
                frame_edge_value,
                path=f"Connection {label}",
                limit=limit - len(details),
            )
        )

    return details


def _sync_detail_path(base: str, part: str) -> str:
    if not base:
        return part
    if part.startswith("["):
        return f"{base}{part}"
    return f"{base}.{part}"


def _json_diff_details(
    backend_value: Any,
    frame_value: Any,
    *,
    path: str = "",
    limit: int = 16,
) -> list[dict[str, Any]]:
    if limit <= 0 or _sync_values_equal(backend_value, frame_value):
        return []

    details: list[dict[str, Any]] = []
    if isinstance(backend_value, dict) and isinstance(frame_value, dict):
        for key in sorted(set(backend_value.keys()) | set(frame_value.keys()), key=str):
            child_path = _sync_detail_path(path, str(key))
            details.extend(
                _json_diff_details(
                    backend_value.get(key),
                    frame_value.get(key),
                    path=child_path,
                    limit=limit - len(details),
                )
            )
            if len(details) >= limit:
                break
        return details

    if isinstance(backend_value, list) and isinstance(frame_value, list):
        max_len = max(len(backend_value), len(frame_value))
        for index in range(max_len):
            child_path = _sync_detail_path(path, f"[{index}]")
            left = backend_value[index] if index < len(backend_value) else None
            right = frame_value[index] if index < len(frame_value) else None
            details.extend(
                _json_diff_details(left, right, path=child_path, limit=limit - len(details))
            )
            if len(details) >= limit:
                break
        return details

    details.append(
        {
            "path": path or "value",
            "backend": _sync_summary(backend_value, path=path),
            "frame": _sync_summary(frame_value, path=path),
        }
    )
    return details


def _frame_sync_snapshot(frame: Frame) -> dict[str, Any]:
    snapshot = frame.to_dict()
    snapshot.pop("last_successful_deploy", None)
    snapshot.pop("last_successful_deploy_at", None)
    frameos_version = current_frameos_version()
    if isinstance(frameos_version, str) and frameos_version:
        snapshot["frameos_version"] = frameos_version
    return snapshot


def _mark_frame_sync_baseline(frame: Frame, synced_at: datetime | None = None) -> None:
    frame.last_successful_deploy = _frame_sync_snapshot(frame)
    frame.last_successful_deploy_at = synced_at or datetime.now(timezone.utc)


def _frame_sync_baseline_missing_version(frame: Frame) -> bool:
    snapshot = frame.last_successful_deploy
    return isinstance(snapshot, dict) and not isinstance(snapshot.get("frameos_version"), str)


def _extract_remote_frame_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("frame"), dict):
        return payload["frame"]
    if isinstance(payload, dict) and isinstance(payload.get("frames"), list) and payload["frames"]:
        first = payload["frames"][0]
        if isinstance(first, dict):
            return first
    if isinstance(payload, dict):
        return payload
    raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="Frame returned an invalid sync payload")


async def _load_live_frame_api_payload(frame: Frame, redis: Redis) -> dict[str, Any]:
    headers = await _frame_admin_session_headers(frame, redis)
    last_status = 0
    last_body = b""
    for path in ("/api/frames/1", f"/api/frames/{frame.id}", "/api/frames"):
        status, body, _headers = await _fetch_frame_http_bytes(frame, redis, path=path, headers=headers)
        last_status = status
        last_body = body
        if status != 200:
            continue
        try:
            return _extract_remote_frame_payload(json.loads(body.decode("utf-8")))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Frame returned invalid JSON: {exc}")
    detail = _decode_bytes(last_body) if last_body else "Unable to load frame sync payload"
    raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail=f"Frame sync load failed: {last_status} {detail}")


async def _frame_admin_session_headers(frame: Frame, redis: Redis) -> dict[str, str]:
    auth = normalize_frame_admin_auth(frame.frame_admin_auth)
    username = str(auth.get("user") or "").strip()
    password = str(auth.get("pass") or "").strip()
    if not auth.get("enabled") or not username or not password:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Frame admin credentials are required before syncing from the backend",
        )
    status, body, headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path="/api/admin/login",
        method="POST",
        body=json.dumps({"username": username, "password": password}),
        headers={"Content-Type": "application/json"},
    )
    if status != 200:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Frame admin login failed: {status} {_decode_bytes(body)}",
        )
    set_cookie = headers.get("set-cookie") or headers.get("Set-Cookie")
    if not set_cookie:
        raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="Frame admin login did not return a session")
    cookie = set_cookie.split(";", 1)[0]
    return {"Cookie": cookie}


def _build_frame_sync_section(backend_frame: dict[str, Any], remote_frame: dict[str, Any]) -> dict[str, Any]:
    changes: list[dict[str, Any]] = []
    for key in FRAME_SYNC_FRAME_KEYS:
        backend_value = _sync_frame_value(key, backend_frame.get(key))
        frame_value = _sync_frame_value(key, remote_frame.get(key))
        if _sync_values_equal(backend_value, frame_value):
            continue
        changes.append(
            {
                "path": key,
                "choice_key": key,
                "label": _sync_label(key),
                "kind": "changed",
                "backend": _sync_summary(backend_value, path=key),
                "frame": _sync_summary(frame_value, path=key),
                "details": _json_diff_details(backend_value, frame_value, path=key, limit=8),
            }
        )
    return {
        "id": "frame_json",
        "label": "frame.json",
        "filename": "frame.json",
        "has_changes": len(changes) > 0,
        "changes": changes,
    }


def _scene_choice_key(scene: Any, index: int) -> str:
    if isinstance(scene, dict):
        return str(scene.get("id") or f"index:{index}")
    return f"index:{index}"


def _scenes_by_id(scenes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if not isinstance(scenes, list):
        return result
    for index, scene in enumerate(scenes):
        result[_scene_choice_key(scene, index)] = scene
    return result


def _build_scene_sync_section(backend_frame: dict[str, Any], remote_frame: dict[str, Any]) -> dict[str, Any]:
    backend_scenes = _scenes_by_id(backend_frame.get("scenes"))
    frame_scenes = _scenes_by_id(remote_frame.get("scenes"))
    changes: list[dict[str, Any]] = []
    for scene_id in sorted(set(backend_scenes.keys()) | set(frame_scenes.keys())):
        backend_scene = backend_scenes.get(scene_id)
        frame_scene = frame_scenes.get(scene_id)
        if backend_scene is None:
            changes.append(
                {
                    "path": f"scenes.{scene_id}",
                    "choice_key": scene_id,
                    "label": f"Scene added on frame: {_scene_title(frame_scene)}",
                    "kind": "added",
                    "backend": "Missing",
                    "frame": _scene_summary(frame_scene),
                    "details": [],
                }
            )
        elif frame_scene is None:
            changes.append(
                {
                    "path": f"scenes.{scene_id}",
                    "choice_key": scene_id,
                    "label": f"Scene only in backend: {_scene_title(backend_scene)}",
                    "kind": "removed",
                    "backend": _scene_summary(backend_scene),
                    "frame": "Missing",
                    "details": [],
                }
            )
        else:
            details = _scene_diff_details(backend_scene, frame_scene, limit=12)
            if not details:
                continue
            scene_title = _scene_title(frame_scene) or _scene_title(backend_scene)
            changes.append(
                {
                    "path": f"scenes.{scene_id}",
                    "choice_key": scene_id,
                    "label": f"Scene changed: {scene_title}",
                    "kind": "changed",
                    "backend": _scene_summary(backend_scene),
                    "frame": _scene_summary(frame_scene),
                    "backend_json": _jsonable(backend_scene),
                    "frame_json": _jsonable(frame_scene),
                    "details": details,
                }
            )
    return {
        "id": "scenes_json",
        "label": "scenes.json",
        "filename": "scenes.json",
        "has_changes": len(changes) > 0,
        "changes": changes,
    }


def _changed_frame_sync_keys(backend_frame: dict[str, Any], remote_frame: dict[str, Any]) -> set[str]:
    return {
        str(change["choice_key"])
        for change in _build_frame_sync_section(backend_frame, remote_frame)["changes"]
        if change.get("choice_key")
    }


def _changed_scene_sync_keys(backend_frame: dict[str, Any], remote_frame: dict[str, Any]) -> set[str]:
    return {
        str(change["choice_key"])
        for change in _build_scene_sync_section(backend_frame, remote_frame)["changes"]
        if change.get("choice_key")
    }


def _sync_item_choices(
    item_choices: dict[str, str] | None,
    section_choice: str,
    changed_keys: set[str],
) -> dict[str, str]:
    if item_choices is None:
        return {key: section_choice for key in changed_keys if section_choice != "ignore"}
    return {
        str(key): choice
        for key, choice in item_choices.items()
        if str(key) in changed_keys and choice != "ignore"
    }


def _scene_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return copy.deepcopy(value)
    return []


def _replace_scene_by_key(scenes: list[Any], scene_key: str, scene: Any | None) -> list[Any]:
    result = copy.deepcopy(scenes)
    for index, existing_scene in enumerate(result):
        if _scene_choice_key(existing_scene, index) != scene_key:
            continue
        if scene is None:
            return result[:index] + result[index + 1 :]
        result[index] = copy.deepcopy(scene)
        return result
    if scene is not None:
        result.append(copy.deepcopy(scene))
    return result


def _scene_field_values(scenes: list[Any], field: str) -> set[str]:
    values: set[str] = set()
    for scene in scenes:
        if isinstance(scene, dict) and scene.get(field):
            values.add(str(scene[field]))
    return values


def _scene_copy_name(scene: Any, existing_names: set[str]) -> str:
    base_name = _scene_title(scene)
    candidate = f"{base_name} (frame copy)"
    if candidate not in existing_names:
        return candidate
    suffix = 2
    while f"{base_name} (frame copy {suffix})" in existing_names:
        suffix += 1
    return f"{base_name} (frame copy {suffix})"


def _copy_frame_scene_variant(scene: Any, existing_scenes: list[Any]) -> Any:
    copied_scene = copy.deepcopy(scene)
    if not isinstance(copied_scene, dict):
        return copied_scene
    existing_ids = _scene_field_values(existing_scenes, "id")
    scene_id = str(uuid.uuid4())
    while scene_id in existing_ids:
        scene_id = str(uuid.uuid4())
    copied_scene["id"] = scene_id
    copied_scene["name"] = _scene_copy_name(copied_scene, _scene_field_values(existing_scenes, "name"))
    return copied_scene


def _apply_scene_sync_choices(
    backend_scenes_value: Any,
    frame_scenes_value: Any,
    choices: dict[str, str],
) -> tuple[list[Any], list[Any]]:
    backend_scenes = _scene_list(backend_scenes_value)
    frame_scenes = _scene_list(frame_scenes_value)
    backend_by_id = _scenes_by_id(backend_scenes_value)
    frame_by_id = _scenes_by_id(frame_scenes_value)

    for scene_key, choice in choices.items():
        backend_scene = backend_by_id.get(scene_key)
        frame_scene = frame_by_id.get(scene_key)
        if choice == "backend":
            backend_scenes = _replace_scene_by_key(backend_scenes, scene_key, backend_scene)
            frame_scenes = _replace_scene_by_key(frame_scenes, scene_key, backend_scene)
        elif choice == "frame":
            backend_scenes = _replace_scene_by_key(backend_scenes, scene_key, frame_scene)
            frame_scenes = _replace_scene_by_key(frame_scenes, scene_key, frame_scene)
        elif choice == "both":
            if backend_scene is None:
                backend_scenes = _replace_scene_by_key(backend_scenes, scene_key, frame_scene)
                frame_scenes = _replace_scene_by_key(frame_scenes, scene_key, frame_scene)
            elif frame_scene is None:
                backend_scenes = _replace_scene_by_key(backend_scenes, scene_key, backend_scene)
                frame_scenes = _replace_scene_by_key(frame_scenes, scene_key, backend_scene)
            else:
                backend_scenes = _replace_scene_by_key(backend_scenes, scene_key, backend_scene)
                frame_scenes = _replace_scene_by_key(frame_scenes, scene_key, backend_scene)
                frame_copy = _copy_frame_scene_variant(frame_scene, backend_scenes + frame_scenes)
                backend_scenes.append(copy.deepcopy(frame_copy))
                frame_scenes.append(copy.deepcopy(frame_copy))

    return backend_scenes, frame_scenes


def _build_frame_sync_status(frame: Frame, remote_frame: dict[str, Any]) -> dict[str, Any]:
    backend_frame = frame.to_dict()
    remote_meta = remote_frame.get("frame_sync") if isinstance(remote_frame.get("frame_sync"), dict) else {}
    frame_section = _build_frame_sync_section(backend_frame, remote_frame)
    scenes_section = _build_scene_sync_section(backend_frame, remote_frame)
    frame_section["backend_updated_at"] = None
    frame_section["frame_updated_at"] = remote_meta.get("frame_config_modified_at")
    scenes_section["backend_updated_at"] = None
    scenes_section["frame_updated_at"] = remote_meta.get("scenes_modified_at")
    sections = [frame_section, scenes_section]
    return {
        "status": "ok",
        "has_changes": any(section["has_changes"] for section in sections),
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "last_in_sync_at": _serialize_datetime(frame.last_successful_deploy_at),
        "backend": {
            "last_successful_deploy_at": _serialize_datetime(frame.last_successful_deploy_at),
            "updated_at": None,
        },
        "frame": {
            "id": remote_frame.get("id"),
            "name": remote_frame.get("name"),
            "current_revision": remote_meta.get("current_revision") or remote_frame.get("frame_sync_current_revision"),
            "deployed_revision": remote_meta.get("deployed_revision") or remote_frame.get("frame_sync_deployed_revision"),
            "frame_config_modified_at": remote_meta.get("frame_config_modified_at"),
            "scenes_modified_at": remote_meta.get("scenes_modified_at"),
            "last_successful_deploy_at": remote_frame.get("last_successful_deploy_at"),
        },
        "sections": sections,
    }


def _sync_frame_json_payload(source: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key in FRAME_SYNC_FRAME_KEYS
        if key in source
        for value in [_sync_frame_value(key, source.get(key))]
        if value not in (None, "", [], {})
    }


def _apply_sync_frame_update(frame: Frame, update_data: dict[str, Any]) -> None:
    previous_buildroot_sd_image_fingerprint = (
        buildroot_sd_image_config_fingerprint(frame)
        if (frame.mode or "rpios") == "buildroot"
        else ""
    )
    old_mode = frame.mode
    for field, value in update_data.items():
        if field in FRAME_SYNC_FRAME_KEYS:
            setattr(frame, field, value)

    if "timezone" in update_data:
        frame.timezone = stored_timezone(frame.timezone) or None
    if "timezone_updater" in update_data:
        frame.timezone_updater = compact_timezone_updater(frame.timezone_updater)

    if "https_proxy" in update_data:
        frame.https_proxy = normalize_https_proxy(frame.https_proxy)
        refresh_tls_certificate_validity_dates(frame)
    if "error_behavior" in update_data:
        frame.error_behavior = normalize_error_behavior(frame.error_behavior)

    if frame.mode == "buildroot" or ((frame.mode or "rpios") == "buildroot" and "buildroot" in update_data):
        ensure_buildroot_frame_defaults(frame, (frame.buildroot or {}).get("platform"))
    elif frame.mode == "embedded" or (frame.mode or "rpios") == "embedded":
        ensure_embedded_frame_defaults(frame, (frame.embedded or {}).get("platform"))
    elif frame.mode == "rpios" and old_mode == "buildroot" and frame.ssh_user == "root":
        frame.ssh_user = "pi"

    if (
        (frame.mode or "rpios") == "buildroot"
        and previous_buildroot_sd_image_fingerprint
        and buildroot_sd_image_config_fingerprint(frame) != previous_buildroot_sd_image_fingerprint
    ):
        clear_buildroot_sd_image(frame)


async def _push_frame_sync_payload(
    frame: Frame,
    redis: Redis,
    payload: dict[str, Any],
    *,
    reload_runtime: bool,
) -> None:
    body = json.dumps(
        {
            **payload,
            **({"skip_runtime_reload": True} if not reload_runtime else {}),
        }
    )
    auth_headers = await _frame_admin_session_headers(frame, redis)
    status, response_body, _headers = await _fetch_frame_http_bytes(
        frame,
        redis,
        path="/api/frames/1",
        method="POST",
        body=body,
        headers={**auth_headers, "Content-Type": "application/json"},
    )
    if status != 200:
        raise HTTPException(
            status_code=HTTPStatus.BAD_GATEWAY,
            detail=f"Frame sync write failed: {status} {_decode_bytes(response_body)}",
        )


async def _push_frame_sync_metadata(frame: Frame, redis: Redis) -> None:
    await _push_frame_sync_payload(
        frame,
        redis,
        {
            "last_successful_deploy": _frame_sync_snapshot(frame),
            "last_successful_deploy_at": _serialize_datetime(frame.last_successful_deploy_at),
            "frame_sync_mark_deployed": True,
        },
        reload_runtime=False,
    )


def _apply_frame_preview_update(frame: Frame, data: FrameUpdateRequest) -> Any:
    update_data = data.model_dump(exclude_unset=True)
    if isinstance(update_data.get("scenes"), str):
        try:
            update_data["scenes"] = json.loads(update_data["scenes"])
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid input for scenes (must be JSON)")

    frame_dict = frame.to_dict()
    preview_data = {**frame_dict, **update_data}
    preview = SimpleNamespace(**preview_data)

    preview.id = frame.id
    preview.status = frame.status
    preview.version = frame.version
    preview.last_successful_deploy = frame.last_successful_deploy
    preview.last_successful_deploy_at = frame.last_successful_deploy_at
    preview.apps = frame.apps
    preview.image_url = frame.image_url

    if "https_proxy" in update_data:
        preview.https_proxy = normalize_https_proxy(preview.https_proxy)
        refresh_tls_certificate_validity_dates(preview)
    if "error_behavior" in update_data:
        preview.error_behavior = normalize_error_behavior(preview.error_behavior)

    old_mode = frame.mode
    if data.mode == "buildroot" or ((preview.mode or "rpios") == "buildroot" and "buildroot" in update_data):
        ensure_buildroot_frame_defaults(preview, (preview.buildroot or {}).get("platform"))
    elif data.mode == "embedded" or (preview.mode or "rpios") == "embedded":
        ensure_embedded_frame_defaults(preview, (preview.embedded or {}).get("platform"))
    elif data.mode == "rpios" and old_mode == "buildroot" and preview.ssh_user == "root":
        preview.ssh_user = "pi"

    def _preview_to_dict():
        result = {**frame.to_dict(), **preview_data}
        result["mode"] = preview.mode
        result["https_proxy"] = normalize_https_proxy(preview.https_proxy)
        result["error_behavior"] = normalize_error_behavior(preview.error_behavior)
        result["ssh_user"] = preview.ssh_user
        return result

    preview.to_dict = _preview_to_dict
    return preview


def _sanitize_scene_state_filename(scene_id: str) -> str:
    sanitized = []
    for ch in scene_id:
        if ch.isalnum() or ch in ["-", "_", "."]:
            sanitized.append(ch)
        else:
            sanitized.append("_")
    collapsed = []
    last_was_underscore = False
    for ch in sanitized:
        if ch == "_":
            if not last_was_underscore:
                collapsed.append(ch)
            last_was_underscore = True
        else:
            collapsed.append(ch)
            last_was_underscore = False
    trimmed = "".join(collapsed).strip("_.")
    if not trimmed:
        trimmed = "untitled"
    return trimmed[:120]


def _frame_state_dir(frame: Frame) -> str:
    return "/srv/frameos/state"


_ascii_re = re.compile(r"[^A-Za-z0-9._-]")
_frame_image_locks: dict[int, asyncio.Lock] = {}
_detached_refresh_tasks: set[asyncio.Task[Any]] = set()


def _schedule_detached_refresh(coro: Awaitable[Any]) -> None:
    task = asyncio.create_task(coro)
    _detached_refresh_tasks.add(task)

    def _cleanup(completed_task: asyncio.Task[Any]) -> None:
        _detached_refresh_tasks.discard(completed_task)
        with contextlib.suppress(asyncio.CancelledError, Exception):
            completed_task.result()

    task.add_done_callback(_cleanup)


def _get_frame_image_lock(frame_id: int) -> asyncio.Lock:
    lock = _frame_image_locks.get(frame_id)
    if not lock:
        lock = asyncio.Lock()
        _frame_image_locks[frame_id] = lock
    return lock


async def _get_cached_frame_image(redis: Redis, cache_key: str) -> bytes | None:
    cached = await redis.get(cache_key)
    if not cached:
        return None
    return cached.encode("latin1") if isinstance(cached, str) else cached


def _header_value(headers: dict[str, Any], name: str) -> str:
    value = headers.get(name) or headers.get(name.lower())
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return str(value or "")


def _sync_hint_headers_from_payload(payload: dict[str, Any] | None) -> dict[str, str]:
    if not payload:
        return {}
    headers = {
        name: str(payload.get(name) or "")
        for name in FRAME_SYNC_IMAGE_HEADER_NAMES
        if payload.get(name) not in (None, "")
    }
    if headers:
        headers["Access-Control-Expose-Headers"] = ", ".join(FRAME_SYNC_IMAGE_HEADER_NAMES)
    return headers


async def _read_frame_sync_hint_headers(redis: Redis, frame_id: int) -> dict[str, str]:
    cached = await redis.get(_frame_sync_hint_cache_key(frame_id))
    if not cached:
        return {}
    try:
        payload = json.loads(cached.decode() if isinstance(cached, bytes) else cached)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return _sync_hint_headers_from_payload(payload)


async def _store_frame_sync_hint_headers(redis: Redis, frame_id: int, frame_headers: dict[str, Any]) -> dict[str, str]:
    changed = _header_value(frame_headers, "x-frameos-sync-changed")
    if changed not in ("0", "1"):
        return await _read_frame_sync_hint_headers(redis, frame_id)

    payload = {
        "X-FrameOS-Sync-Changed": changed,
        "X-FrameOS-Sync-Checked-At": datetime.now(timezone.utc).isoformat(),
    }
    for name in FRAME_SYNC_IMAGE_HEADER_NAMES:
        if name in ("X-FrameOS-Sync-Changed", "X-FrameOS-Sync-Checked-At"):
            continue
        value = _header_value(frame_headers, name.lower())
        if value:
            payload[name] = value

    await redis.set(_frame_sync_hint_cache_key(frame_id), json.dumps(payload), ex=FRAME_STATES_CACHE_TTL_SECONDS)
    return _sync_hint_headers_from_payload(payload)


async def _wait_for_cached_frame_image(redis: Redis, cache_key: str) -> bytes | None:
    deadline = time.monotonic() + FRAME_IMAGE_REFRESH_WAIT_SECONDS
    while time.monotonic() < deadline:
        cached = await _get_cached_frame_image(redis, cache_key)
        if cached:
            return cached
        await asyncio.sleep(0.1)
    return await _get_cached_frame_image(redis, cache_key)


def _frame_image_dimensions(frame: Frame) -> tuple[int, int]:
    width = int(frame.width or 800)
    height = int(frame.height or 600)
    if frame.rotate in (90, 270):
        width, height = height, width
    return width, height


def _frame_image_placeholder(frame: Frame) -> bytes:
    width, height = _frame_image_dimensions(frame)
    return render_line_of_text_png("no image", width, height)


async def _frame_image_placeholder_response(frame: Frame) -> Response:
    # PIL rendering is CPU-bound; keep it off the event loop.
    content = await asyncio.get_running_loop().run_in_executor(None, _frame_image_placeholder, frame)
    return Response(
        content=content,
        media_type="image/png",
        headers=FRAME_IMAGE_PLACEHOLDER_HEADERS,
    )


async def _frame_image_error_response(frame: Frame, detail: str, status_code: int | None = None) -> Response:
    width, height = _frame_image_dimensions(frame)
    headers = {
        "x-frameos-image-state": "error",
        **({"x-frameos-image-error-status": str(status_code)} if status_code else {}),
    }
    content = await asyncio.get_running_loop().run_in_executor(
        None, render_line_of_text_png, detail or "image error", width, height
    )
    return Response(
        content=content,
        media_type="image/png",
        headers=headers,
    )


async def _release_frame_image_refresh_lock(redis: Redis, lock_key: str, lock_token: str) -> None:
    current = await redis.get(lock_key)
    if isinstance(current, bytes):
        current = current.decode("utf-8", errors="ignore")
    if current == lock_token:
        await redis.delete(lock_key)


async def _store_frame_image(
    db: Session,
    redis: Redis,
    frame: Frame,
    body: bytes,
    *,
    scene_id: str | None = None,
    publish_rendered: bool = True,
) -> dict[str, Any]:
    cache_key = _frame_image_cache_key(frame.id)
    await redis.set(cache_key, body, ex=86400 * 30)

    stored_scene_id = scene_id
    width = height = None
    if stored_scene_id:
        stored_scene_id = _scene_image_scene_id_for_frame(frame, stored_scene_id)

    if stored_scene_id:
        from app.models.scene_image import SceneImage
        from app.api.scene_images import _generate_thumbnail

        def _decode_and_thumbnail():
            image_width = image_height = None
            try:
                from PIL import Image

                img = Image.open(io.BytesIO(body))
                image_width, image_height = img.width, img.height
            except Exception:
                pass
            thumb, t_width, t_height = _generate_thumbnail(body)
            return image_width, image_height, thumb, t_width, t_height

        width, height, thumb, t_width, t_height = await asyncio.get_running_loop().run_in_executor(
            None, _decode_and_thumbnail
        )

        now = datetime.utcnow()
        img_row = (
            db.query(SceneImage)
            .filter_by(project_id=frame.project_id, frame_id=frame.id, scene_id=stored_scene_id)
            .first()
        )
        if img_row:
            img_row.image = body
            img_row.timestamp = now
            img_row.width = width
            img_row.height = height
            img_row.thumb_image = thumb
            img_row.thumb_width = t_width
            img_row.thumb_height = t_height
        else:
            img_row = SceneImage(
                project_id=frame.project_id,
                frame_id=frame.id,
                scene_id=stored_scene_id,
                image=body,
                timestamp=now,
                width=width,
                height=height,
                thumb_image=thumb,
                thumb_width=t_width,
                thumb_height=t_height,
            )
            db.add(img_row)
        db.commit()

        await publish_message(
            redis,
            "new_scene_image",
            {
                "project_id": frame.project_id,
                "frameId": frame.id,
                "sceneId": stored_scene_id,
                "timestamp": now.isoformat(),
                "width": width,
                "height": height,
            },
        )

    if publish_rendered:
        await publish_message(
            redis,
            "frame_rendered",
            {
                "project_id": frame.project_id,
                "frameId": frame.id,
                "sceneId": stored_scene_id,
                "width": width,
                "height": height,
            },
        )

    return {
        "sceneId": stored_scene_id,
        "width": width,
        "height": height,
    }


def _normalize_upload_scenes_payload(body: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if isinstance(body, (bytes, bytearray)):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            _bad_request("uploadScenes payload must be valid JSON")

    if not isinstance(body, dict):
        _bad_request("uploadScenes payload must be a JSON object")

    scenes_payload = body.get("scenes")
    if not isinstance(scenes_payload, list):
        _bad_request("uploadScenes payload must include scenes as an array")
    return scenes_payload, body
    return [], body  # for mypy


def _validate_upload_scenes_payload(
    scenes: list[dict[str, Any]],
    scene_id: str | None = None,
) -> None:
    if not scenes:
        _bad_request("uploadScenes payload must include at least one scene")

    scene_ids: set[str] = set()
    for scene in scenes:
        if not isinstance(scene, dict):
            _bad_request("uploadScenes scenes must be objects")
        scene_id = scene.get("id")
        if not isinstance(scene_id, str) or not scene_id:
            _bad_request("uploadScenes scenes must include an id")
        scene_ids.add(scene_id)

    if scene_id and scene_id not in scene_ids:
        _bad_request("uploadScenes sceneId must reference one of the uploaded scenes")

    for scene in scenes:
        nodes = scene.get("nodes") or []
        if not isinstance(nodes, list):
            _bad_request(f"Scene '{scene.get('id')}' has invalid nodes list")
        for node in nodes:
            if not isinstance(node, dict):
                _bad_request(f"Scene '{scene.get('id')}' has invalid node entry")
            node_type = node.get("type")
            data = node.get("data") or {}
            if not isinstance(data, dict):
                _bad_request(f"Scene '{scene.get('id')}' has invalid node data")
            if node_type == "scene":
                keyword = data.get("keyword")
                if not isinstance(keyword, str) or not keyword:
                    _bad_request(f"Scene '{scene.get('id')}' has invalid scene reference")
                if keyword not in scene_ids:
                    _bad_request(f"Scene '{scene.get('id')}' references missing scene '{keyword}'")
            elif node_type == "dispatch" and data.get("keyword") == "setCurrentScene":
                config = data.get("config") or {}
                if not isinstance(config, dict):
                    _bad_request(f"Scene '{scene.get('id')}' has invalid dispatch config")
                target_scene_id = config.get("sceneId")
                if isinstance(target_scene_id, str) and target_scene_id and target_scene_id not in scene_ids:
                    _bad_request(
                        f"Scene '{scene.get('id')}' references missing scene '{target_scene_id}'"
                    )


def _ascii_safe(name: str) -> str:
    """Return a stripped ASCII fallback (for very old clients)."""
    return _ascii_re.sub("_", name)[:150] or "download"


def _normalise_remote_response(resp: Any) -> tuple[int, Any]:
    """
    Remote “http” command returns {"status": int, "body": str}.
    Convert that (or a normal HTTPX Response) into (status-code, payload).
    """
    if isinstance(resp, dict) and {"status", "body"} <= resp.keys():
        status = int(resp.get("status", 0))
        body_raw = resp.get("body", "")
        try:
            payload = json.loads(body_raw)
        except (TypeError, json.JSONDecodeError):
            payload = body_raw
        return status, payload

    # already a JSON-payload (e.g. other remote commands)
    return 200, resp


def _bytes_or_json(blob: bytes | str):
    """
    • If *blob* is str → return it as-is (already JSON-decoded upstream).
    • If bytes → try UTF-8 → json.loads() → dict.
      - valid JSON  → dict/list/…           (good for /state, /states)
      - invalid JSON → leave as raw bytes   (needed for /image etc.)
    """
    if isinstance(blob, (bytes, bytearray)):
        try:
            return json.loads(blob.decode())  # UTF-8 is the JSON default
        except Exception:
            return blob  # truly binary
    return blob


def _decode_bytes(data: bytes) -> str:
    try:
        return data.decode()
    except Exception:
        return data.decode("latin1", errors="replace")


def _truncate_text(msg: str, limit: int = 400) -> str:
    msg = msg.strip()
    if len(msg) > limit:
        msg = msg[: limit - 3].rstrip() + "..."
    return msg


def _format_body_preview(body: bytes) -> str:
    if not body:
        return ""
    return _truncate_text(_decode_bytes(body))




async def _icmp_ping_host(host: str, *, timeout: float = 2.0) -> tuple[bool, float | None, str]:
    if not shutil.which("ping"):
        return False, None, "ping command not available on server"

    started = time.perf_counter()
    timeout_arg = str(int(timeout * 1000)) if sys.platform == "darwin" else str(int(timeout))
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping",
            "-c",
            "1",
            "-W",
            timeout_arg,
            host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return False, None, "ping command not available on server"

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout + 1.0)
    except asyncio.TimeoutError:
        proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        return False, None, f"Timeout after {timeout:.1f}s"

    elapsed_ms = (time.perf_counter() - started) * 1000
    if proc.returncode == 0:
        message = _decode_bytes(stdout or b"") or f"Reply from {host}"
        return True, elapsed_ms, _truncate_text(message)

    message = _decode_bytes(stderr or stdout or b"") or f"Unable to reach {host}"
    return False, elapsed_ms, _truncate_text(message)


async def _forward_frame_request(
    frame: Frame,
    redis: Redis,
    *,
    path: str,
    method: str = "GET",
    json_body: Any | None = None,
    cache_key: str | None = None,
    cache_ttl: int = 1,
) -> Any:
    if cache_key and (cached := await redis.get(cache_key)):
        return _bytes_or_json(cached)

    if json_body is None:
        status, body, headers = await _fetch_frame_http_bytes(
            frame,
            redis,
            path=path,
            method=method,
        )
        if status == 200:
            if cache_key:
                await redis.set(cache_key, body, ex=cache_ttl)
            payload = _bytes_or_json(body)
            if headers.get("content-type", "").startswith("application/json") or not isinstance(payload, bytes):
                return payload
            return _decode_bytes(body)

        if cache_key and (cached := await redis.get(cache_key)):
            return _bytes_or_json(cached)

        raise HTTPException(status_code=400, detail="Unable to reach frame")

    # The remote HTTP command wants a *string* while httpx needs either
    #   • json=<obj>   for real JSON payloads
    #   • content=<bytes> for arbitrary binary bodies.
    body_for_remote: str | None = None
    if json_body is not None:
        if isinstance(json_body, (bytes, bytearray)):
            # keep the bytes unchanged – use latin-1 for a 1-to-1 mapping
            body_for_remote = json_body.decode("latin1")
        else:
            body_for_remote = json.dumps(json_body)

    if await _use_remote(frame, redis):
        remote_resp = await http_get_on_frame(
            frame.id,
            _build_frame_path(frame, path, method),
            method=method.upper(),
            body=body_for_remote,
            headers=_auth_headers(frame),
            redis=redis,
        )
        status, payload = _normalise_remote_response(remote_resp)
        if status == 200:
            if cache_key:
                if isinstance(payload, (bytes, bytearray)):
                    await redis.set(cache_key, payload, ex=cache_ttl)
                else:
                    try:
                        await redis.set(
                            cache_key, json.dumps(payload).encode(), ex=cache_ttl
                        )
                    except TypeError:
                        pass
            return payload

        raise HTTPException(status_code=400, detail=f"Remote error: {status} {payload}")

    url = _build_frame_url(frame, path, method)
    hdrs = _auth_headers(frame)
    verify = _httpx_verify(frame)
    async with httpx.AsyncClient(verify=verify) as client:
        try:
            if isinstance(json_body, (bytes, bytearray)):
                # binary/event bodies
                response = await client.request(
                    method,
                    url,
                    content=json_body,
                    headers=hdrs,
                    timeout=60.0,
                )
            elif json_body is not None:
                # normal JSON payload
                response = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=hdrs,
                    timeout=60.0,
                )
            else:
                # no body at all
                response = await client.request(
                    method,
                    url,
                    headers=hdrs,
                    timeout=60.0,
                )
        except httpx.ReadTimeout:
            raise HTTPException(
                status_code=HTTPStatus.REQUEST_TIMEOUT, detail=f"Timeout to {url}"
            )
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
            )

    if response.status_code == 200:
        if cache_key:
            await redis.set(cache_key, response.content, ex=cache_ttl)
        if response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.text

    # last-ditch: serve stale cache (JSON or bytes) ------------------------
    if cache_key and (cached := await redis.get(cache_key)):
        return _bytes_or_json(cached)

    raise HTTPException(
        status_code=400, detail="Unable to reach frame"
    )


async def _load_frame_states(redis: Redis, frame: Frame) -> dict[str, Any]:
    try:
        return _normalise_frame_states_payload(
            await _forward_frame_request(frame, redis, path="/states")
        )
    except HTTPException:
        state = await _forward_frame_request(frame, redis, path="/state")
        return _normalise_frame_states_payload(state)


async def _refresh_frame_states_cache(
    frame_id: int,
    cache_key: str,
    lock_key: str,
    invalidated_key: str,
    started_at: float,
) -> None:
    redis = create_redis_connection()
    db = SessionLocal()
    completed = False
    try:
        frame = db.get(Frame, frame_id)
        if frame is None:
            return
        state_record = await _load_frame_states(redis, frame)
        invalidated_at = await redis.get(invalidated_key)
        if invalidated_at:
            invalidated_at = (
                invalidated_at.decode()
                if isinstance(invalidated_at, bytes)
                else invalidated_at
            )
            with contextlib.suppress(TypeError, ValueError):
                if float(invalidated_at) > started_at:
                    completed = True
                    return
        await _write_frame_states_cache(redis, cache_key, state_record)
        if state_record.get("sceneId"):
            await redis.set(f"frame:{frame.id}:active_scene", state_record["sceneId"])
        completed = True
    except Exception as exc:
        cached = await _read_frame_states_cache(redis, cache_key)
        fallback_record = _normalise_frame_states_payload(cached)
        if not fallback_record.get("sceneId"):
            fallback_record["sceneId"] = await _active_scene_id_from_cache(redis, frame_id)
        await _write_frame_states_cache(
            redis,
            cache_key,
            {
                **fallback_record,
                "error": str(exc) or exc.__class__.__name__,
            },
        )
        completed = True
    finally:
        if completed:
            with contextlib.suppress(Exception):
                await redis.delete(lock_key)
        db.close()
        await close_redis_connection(redis)


async def _schedule_frame_states_cache_refresh(
    redis: Redis,
    frame_id: int,
    cache_key: str,
    lock_key: str,
) -> bool:
    invalidated_key = _frame_states_cache_invalidated_key(frame_id)
    started_at = time.time()
    acquired = await redis.set(
        lock_key,
        "1",
        ex=FRAME_STATES_CACHE_LOCK_SECONDS,
        nx=True,
    )
    if acquired:
        _schedule_detached_refresh(
            _refresh_frame_states_cache(
                frame_id,
                cache_key,
                lock_key,
                invalidated_key,
                started_at,
            )
        )
    return True


def _frame_states_cache_meta(
    *,
    cached: bool,
    refreshing: bool,
    fetched_at: float | None,
    error: str | None = None,
) -> dict[str, Any]:
    retry_after = (
        FRAME_STATES_CACHE_FAILURE_RETRY_AFTER_SECONDS
        if error
        else FRAME_STATES_CACHE_RETRY_AFTER_SECONDS
    )
    return {
        "cached": cached,
        "refreshing": refreshing,
        "fetched_at": fetched_at,
        "refresh_after": FRAME_STATES_CACHE_REFRESH_AFTER_SECONDS,
        "retry_after": retry_after,
        **({"error": error} if error else {}),
    }


async def _active_scene_id_from_cache(redis: Redis, frame_id: int) -> str:
    active_scene = await redis.get(f"frame:{frame_id}:active_scene")
    if not active_scene:
        return ""
    return active_scene.decode() if isinstance(active_scene, bytes) else str(active_scene)


async def _remote_file_md5(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
) -> Tuple[str, bool]:
    """
    Return (md5, exists). Prefer the websocket remote, fall back to SSH.
    """
    if await _use_remote(frame, redis):
        resp = await file_md5_on_frame(frame.id, remote_path, redis=redis)
        return resp.get("md5", ""), bool(resp.get("exists", False))

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        md5_out: list[str] = []
        response = await exec_command(
            db,
            redis,
            frame,
            ssh,
            f"md5sum {shlex.quote(remote_path)}",
            output=md5_out,
            log_output=False,
            raise_on_error=False,
        )
        if response != 0:
            return "", False
        txt = "".join(md5_out).strip()
        if not txt:
            return "", False
        return txt.split()[0], True
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


async def _remote_download_file(
    db: Session,
    redis: Redis,
    frame: Frame,
    remote_path: str,
) -> bytes:
    """
    Download *remote_path* – remote first, SSH SCP otherwise.
    """
    if await _use_remote(frame, redis):
        return await file_read_on_frame(frame.id, remote_path, redis=redis)

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        with NamedTemporaryFile(delete=False) as tmp:
            tmp_name = tmp.name
        await asyncssh.scp((ssh, shlex.quote(remote_path)), tmp_name, recurse=False)
        with open(tmp_name, "rb") as fh:
            data = fh.read()
        os.remove(tmp_name)
        return data
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)


# ---------------------------------------------------------------------------
#   📡  Endpoints
# ---------------------------------------------------------------------------


_LATEST_LOG_AT_UNSET = object()


def _frame_activity_log_filter():
    return Log.type.in_(FRAME_ACTIVITY_LOG_TYPES)


def _frame_to_response_dict(
    frame: Frame, latest_log_at: datetime | None | object = _LATEST_LOG_AT_UNSET
) -> dict[str, Any]:
    data = frame.to_dict()
    if (frame.mode or "rpios") == "embedded":
        try:
            firmware = latest_embedded_firmware(frame) or with_embedded_firmware_layout(frame, {
                "status": "idle",
                "platform": normalize_embedded_platform((frame.embedded or {}).get("platform")),
                "flashSize": embedded_flash_size_for_frame(frame),
                "otaSupported": embedded_ota_supported_for_frame(frame),
            })
        except ValueError:
            firmware = None
        if firmware:
            data["embedded"] = {**(data.get("embedded") or {}), "firmware": firmware}
    if latest_log_at is not _LATEST_LOG_AT_UNSET:
        data["last_log_at"] = (
            latest_log_at.replace(tzinfo=timezone.utc).isoformat() if isinstance(latest_log_at, datetime) else None
        )
    return data


@api_project.get("/frames", response_model=FramesListResponse)
async def api_frames_list(
    db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    project_id = current_project_id()
    frames = db.query(Frame).filter_by(project_id=project_id).all()
    latest_logs = dict(
        db.query(Log.frame_id, func.max(Log.timestamp))
        .filter(Log.project_id == project_id)
        .filter(_frame_activity_log_filter())
        .group_by(Log.frame_id)
        .all()
    )
    return {
        "frames": [
            {
                **_frame_to_response_dict(f, latest_logs.get(f.id)),
                "active_scene_id": await _active_scene_id_from_cache(redis, f.id),
                "active_connections": await number_of_connections_for_frame(
                    redis, f.id
                ),
            }
            for f in frames
        ]
    }


@api_project.get("/frames/{id:int}/state", response_model=FrameStateResponse)
async def api_frame_get_state(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = _project_frame(db, id) or _not_found()
    state = await _forward_frame_request(
        frame,
        redis,
        path="/state",
        cache_key=_frame_state_cache_key(frame.id),
    )
    if isinstance(state, dict) and state.get("sceneId"):
        await redis.set(f"frame:{frame.id}:active_scene", state["sceneId"])
    return state


@api_project.get("/frames/{id:int}/states", response_model=FrameStateResponse)
async def api_frame_get_states(
    id: int,
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    cache_key = _frame_states_cache_key(frame.id)
    lock_key = _frame_states_cache_lock_key(frame.id)
    cached = await _read_frame_states_cache(redis, cache_key)

    if cached is not None:
        fetched_at = float(cached.get("fetched_at") or 0)
        cache_error = cached.get("error") if isinstance(cached.get("error"), str) else None
        refresh_after = (
            FRAME_STATES_CACHE_FAILURE_RETRY_AFTER_SECONDS
            if cache_error
            else FRAME_STATES_CACHE_REFRESH_AFTER_SECONDS
        )
        refreshing = refresh or time.time() - fetched_at >= refresh_after
        if refreshing:
            refreshing = await _schedule_frame_states_cache_refresh(
                redis,
                frame.id,
                cache_key,
                lock_key,
            )
        state_record = _normalise_frame_states_payload(cached)
        if state_record.get("sceneId"):
            await redis.set(f"frame:{frame.id}:active_scene", state_record["sceneId"])
        return {
            **state_record,
            "cache": _frame_states_cache_meta(
                cached=True,
                refreshing=refreshing,
                fetched_at=fetched_at,
                error=cache_error,
            ),
        }

    refreshing = await _schedule_frame_states_cache_refresh(
        redis,
        frame.id,
        cache_key,
        lock_key,
    )
    return {
        "sceneId": await _active_scene_id_from_cache(redis, frame.id),
        "states": {},
        "cache": _frame_states_cache_meta(
            cached=False,
            refreshing=refreshing,
            fetched_at=None,
        ),
    }


@api_project.get(
    "/frames/{id:int}/uploaded_scenes", response_model=FrameUploadedScenesResponse
)
async def api_frame_get_uploaded_scenes(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = _project_frame(db, id) or _not_found()
    payload = await _forward_frame_request(
        frame,
        redis,
        path="/getUploadedScenes",
        cache_key=_frame_uploaded_scenes_cache_key(frame.id),
    )
    if isinstance(payload, dict) and payload.get("sceneId"):
        await redis.set(f"frame:{frame.id}:active_scene", payload["sceneId"])
    return payload


@api_project.get("/frames/{id:int}/ping", response_model=FramePingResponse)
async def api_frame_ping(
    id: int,
    mode: str = Query("icmp"),
    path: str | None = Query(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    mode_normalised = (mode or "").strip().lower()
    if mode_normalised not in {"icmp", "http"}:
        _bad_request("Ping mode must be 'icmp' or 'http'")

    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    if mode_normalised == "icmp":
        ok, elapsed_ms, message = await _icmp_ping_host(frame.frame_host)
        return FramePingResponse(
            ok=ok,
            mode="icmp",
            target=frame.frame_host,
            elapsed_ms=elapsed_ms,
            status=None,
            message=message,
        )

    ping_path = (path or "/ping").strip() or "/ping"
    if not ping_path.startswith("/"):
        ping_path = f"/{ping_path}"
    if len(ping_path) > 512:
        _bad_request("Ping path is too long")

    scheme, port = _frame_scheme_port(frame)
    display_target = f"{scheme}://{frame.frame_host}:{port}{ping_path}"
    started = time.perf_counter()

    try:
        status, body, _hdrs = await _fetch_frame_http_bytes(
            frame, redis, path=ping_path, method="GET"
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        message = _format_body_preview(body) or f"HTTP {status}"
        return FramePingResponse(
            ok=200 <= status < 400,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=status,
            message=message,
        )
    except HTTPException as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return FramePingResponse(
            ok=False,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=None,
            message=_truncate_text(detail),
        )
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        return FramePingResponse(
            ok=False,
            mode="http",
            target=display_target,
            elapsed_ms=elapsed_ms,
            status=None,
            message=_truncate_text(str(exc)),
        )


@api_project.post("/frames/{id:int}/event/{event}")
async def api_frame_event(
    id: int,
    event: str,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    body = await (
        request.json()
        if request.headers.get("content-type") == "application/json"
        else request.body()
    )
    if event == "uploadScenes":
        scenes, body = _normalize_upload_scenes_payload(body)
        scene_id = body.get("sceneId")
        _validate_upload_scenes_payload(scenes, scene_id)
    try:
        await _forward_frame_request(
            frame, redis, path=f"/event/{event}", method="POST", json_body=body
        )
        if event in {"setCurrentScene", "setSceneState", "uploadScenes"}:
            scene_id = body.get("sceneId") if isinstance(body, dict) else None
            await _mark_frame_states_cache_stale(
                redis,
                frame,
                scene_id=scene_id if isinstance(scene_id, str) else None,
            )
        return "OK"
    except HTTPException as exc:
        await log(
            db, redis, id, "stderr", f"Error on frame event {event}: {exc.detail}"
        )
        raise exc
    except RuntimeError as exc:
        await log(db, redis, id, "stderr", f"Error on frame event {event}: {str(exc)}")
        raise exc


@api_project.post("/frames/{id:int}/upload_scenes")
async def api_frame_upload_scenes(
    id: int,
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    body = await (
        request.json()
        if request.headers.get("content-type") == "application/json"
        else request.body()
    )
    scenes, body = _normalize_upload_scenes_payload(body)
    scene_id = body.get("sceneId")
    _validate_upload_scenes_payload(scenes, scene_id)
    try:
        await _forward_frame_request(
            frame, redis, path="/uploadScenes", method="POST", json_body=body
        )
        await _mark_frame_states_cache_stale(
            redis,
            frame,
            scene_id=scene_id if isinstance(scene_id, str) else None,
        )
        return "OK"
    except HTTPException as exc:
        await log(
            db,
            redis,
            id,
            "stderr",
            f"Error on upload scenes request: {exc.detail}",
        )
        raise exc
    except RuntimeError as exc:
        await log(db, redis, id, "stderr", f"Error on upload scenes request: {str(exc)}")
        raise exc


@api_project.post("/frames/{id:int}/download_build_zip")
async def api_frame_local_build_zip(                 # noqa: D401
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    # Locate Nim (needed only for path checks inside helpers)
    try:
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    # Workspace ────────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)
        source_dir = deployer.create_local_source_folder(tmp)

        # Apply all frame‑specific code generation (scenes, drivers, …)
        await deployer.make_local_modifications(source_dir, compilation_mode=frame_compilation_mode(frame))
        await copy_custom_fonts_to_local_source_folder(db, source_dir, frame.project_id)

        # Package → .zip
        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,   # 🚩 allow < 1980 timestamps
        ) as zf:
            for root, _dirs, files in os.walk(source_dir):
                for file in files:
                    full = os.path.join(root, file)
                    arc  = os.path.relpath(full, source_dir)
                    zf.write(full, arc)

        # --- read once *before* tmp dir vanishes ---------------------------
        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

        async def sender():
            # stream from an in‑memory view – no filesystem dependency
            yield zip_bytes

        safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
        filename  = f"{safe_name}_{deployer.build_id}.zip"
        headers   = {
            "Content-Disposition": (
                f'attachment; filename="{_ascii_safe(filename)}"'
            )
        }
        return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_project.post("/frames/{id:int}/download_c_source_zip")
async def api_frame_local_c_source_zip(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    try:
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)

        try:
            arch = await deployer.get_cpu_architecture()
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.BAD_GATEWAY,
                detail=f"Unable to detect frame architecture: {exc}",
            )

        source_dir = deployer.create_local_source_folder(tmp)
        compilation_mode = frame_compilation_mode(frame)
        await deployer.make_local_modifications(source_dir, compilation_mode=compilation_mode)
        await copy_custom_fonts_to_local_source_folder(db, source_dir, frame.project_id)

        build_dir = os.path.join(tmp, f"build_{deployer.build_id}")
        os.makedirs(build_dir, exist_ok=True)
        await deployer.create_local_build_archive(build_dir, source_dir, arch, compilation_mode=compilation_mode)

        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}_c_source.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,
        ) as zf:
            for root, _dirs, files in os.walk(build_dir):
                for file in files:
                    full = os.path.join(root, file)
                    arc = os.path.relpath(full, build_dir)
                    zf.write(full, arc)

        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

    async def sender():
        yield zip_bytes

    safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
    filename = f"{safe_name}_{deployer.build_id}_c_source.zip"
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{_ascii_safe(filename)}"'
        )
    }
    return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_project.post("/frames/{id:int}/download_binary_zip")
async def api_frame_local_binary_zip(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    try:
        # Ensure Nim is available before attempting to build
        nim_path = find_nim_v2()
    except Exception as exc:
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Unable to locate Nim installation: {exc}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        deployer = FrameDeployer(db, redis, frame, nim_path, tmp)
        builder = FrameBinaryBuilder(db=db, redis=redis, frame=frame, deployer=deployer, temp_dir=tmp)

        try:
            build_plan = await builder.plan_build(force_cross_compile=True)
            build_result = await builder.build(build_plan)
        except Exception as exc:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Failed to build FrameOS binary: {exc}",
            ) from exc

        binary_path = build_result.binary_path
        if not binary_path:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail="Cross compilation completed without producing a binary",
            )

        dist_dir = os.path.join(tmp, "dist")
        os.makedirs(dist_dir, exist_ok=True)
        bin_dir = os.path.join(dist_dir, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        shutil.copy2(binary_path, os.path.join(bin_dir, "frameos"))
        if build_result.driver_library_paths:
            driver_dir = os.path.join(dist_dir, "drivers")
            os.makedirs(driver_dir, exist_ok=True)
            for driver_library_path in build_result.driver_library_paths:
                if not os.path.isfile(driver_library_path):
                    raise HTTPException(
                        status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                        detail=f"Shared driver library missing after build: {driver_library_path}",
                    )
                shutil.copy2(driver_library_path, os.path.join(driver_dir, os.path.basename(driver_library_path)))
        if build_result.scene_library_paths:
            scene_dir = os.path.join(dist_dir, "scenes")
            os.makedirs(scene_dir, exist_ok=True)
            for scene_library_path in build_result.scene_library_paths:
                if not os.path.isfile(scene_library_path):
                    raise HTTPException(
                        status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                        detail=f"Shared scene library missing after build: {scene_library_path}",
                    )
                shutil.copy2(scene_library_path, os.path.join(scene_dir, os.path.basename(scene_library_path)))

        zip_path = os.path.join(tmp, f"frameos_{deployer.build_id}_binary.zip")
        with zipfile.ZipFile(
            zip_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            strict_timestamps=False,
        ) as zf:
            for root, _dirs, files in os.walk(dist_dir):
                for file in files:
                    full = os.path.join(root, file)
                    relative = os.path.relpath(full, dist_dir)
                    arc = os.path.join("dist", relative)
                    zf.write(full, arc)

        async with aiofiles.open(zip_path, "rb") as fh:
            zip_bytes = await fh.read()

    async def sender():
        yield zip_bytes

    safe_name = (frame.name or "frame").replace(" ", "_").replace("/", "_")
    filename = f"{safe_name}_{deployer.build_id}_binary.zip"
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{_ascii_safe(filename)}"'
        )
    }
    return StreamingResponse(sender(), headers=headers, media_type="application/zip")


@api_open.get("/projects/{project_id}/frames/{id:int}/asset")
async def api_frame_get_asset(
    project_id: int,
    id: int,
    request: Request,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = await _public_project_frame(
        project_id=project_id,
        frame_id=id,
        request=request,
        db=db,
        token=token,
        authorization=authorization,
    )

    assets_path = frame.assets_path or "/srv/assets"
    rel_path = request.query_params.get("path") or _bad_request(
        "Path parameter is required",
    )
    mode = request.query_params.get("mode", "download")
    filename = request.query_params.get("filename", os.path.basename(rel_path))
    thumb = request.query_params.get("thumb") == "1"

    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    # Trailing separator so "/srv/assets-other" can't pass as "/srv/assets",
    # matching the upload endpoints.
    normalized_assets_path = os.path.normpath(assets_path)
    if full_path != normalized_assets_path and not full_path.startswith(normalized_assets_path + os.sep):
        _bad_request("Invalid asset path")

    if thumb:
        if os.path.splitext(rel_path)[1].lower() not in {
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".bmp",
            ".webp",
        }:
            raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Not an image")

        md5_key = f"asset-md5:{full_path}"
        cached_md5 = await redis.get(md5_key)
        if cached_md5:
            full_md5 = cached_md5.decode() if isinstance(cached_md5, bytes) else cached_md5
        else:
            full_md5, exists = await _remote_file_md5(db, redis, frame, full_path)
            if not full_md5:
                _bad_request("Invalid asset path")
            await redis.set(md5_key, full_md5, ex=86400 * 30)

        cache_key = f"asset:thumb:{full_md5}"
        if cached := await redis.get(cache_key):
            data = cached
        else:
            thumb_root = os.path.join(assets_path, ".thumbs")
            thumb_rel = full_md5 + ".320x320.jpg"
            thumb_full = os.path.normpath(os.path.join(thumb_root, thumb_rel))

            try:
                data = await _remote_download_file(db, redis, frame, thumb_full)
                await redis.set(cache_key, data, ex=86400 * 30)
            except Exception:
                cmd = (
                    f"mkdir -p {shlex.quote(os.path.dirname(thumb_full))} && "
                    f"convert {shlex.quote(full_path)} -thumbnail 320x320 "
                    f"{shlex.quote(thumb_full)}"
                )
                await exec_shell_on_frame(frame.id, cmd, redis=redis)

                data = await _remote_download_file(db, redis, frame, thumb_full)
                await redis.set(cache_key, data, ex=86400 * 30)

        return StreamingResponse(io.BytesIO(data), media_type="image/jpeg")

    if await _use_remote(frame, redis):
        try:
            data = await file_read_on_frame(frame.id, full_path, redis=redis)
        except Exception:  # file_read returns RuntimeError on missing file
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found",
            )

        md5 = hashlib.md5(data).hexdigest()
        cache_key = f"asset:{md5}"
        await redis.set(cache_key, data, ex=86400 * 30)

    else:
        md5, exists = await _remote_file_md5(db, redis, frame, full_path)
        if not exists:
            raise HTTPException(
                status_code=HTTPStatus.NOT_FOUND, detail="Asset not found",
            )

        cache_key = f"asset:{md5}"
        if cached := await redis.get(cache_key):
            data = cached
        else:
            data = await _remote_download_file(db, redis, frame, full_path)
            await redis.set(cache_key, data, ex=86400 * 30)

    media_type = "application/octet-stream"
    if mode == "image":
        media_type = (
            mimetypes.guess_type(filename or rel_path)[0]
            or "application/octet-stream"
        )

    return StreamingResponse(
        io.BytesIO(data),
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f"{'attachment' if mode == 'download' else 'inline'}; "
                f'filename="{_ascii_safe(filename)}"; '
                f"filename*=UTF-8''{quote(filename, safe='')}"
            ),
        },
    )


@api_project.get("/frames/{id:int}", response_model=FrameResponse)
async def api_frame_get(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    latest_log_at = (
        db.query(func.max(Log.timestamp))
        .filter_by(project_id=frame.project_id, frame_id=frame.id)
        .filter(_frame_activity_log_filter())
        .scalar()
    )
    data = _frame_to_response_dict(frame, latest_log_at)
    active = await redis.get(f"frame:{frame.id}:active_connections")
    data["active_connections"] = int(active or 0)
    data["active_scene_id"] = await _active_scene_id_from_cache(redis, frame.id)
    return {"frame": data}


@api_project.get("/frames/{id:int}/sync")
async def api_frame_sync_status(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    remote_frame = await _load_live_frame_api_payload(frame, redis)
    sync_status = _build_frame_sync_status(frame, remote_frame)
    repaired_baseline = False
    if (
        not sync_status["has_changes"]
        and _frame_sync_baseline_missing_version(frame)
        and remote_frame.get("last_successful_deploy_at")
        and current_frameos_version()
    ):
        _mark_frame_sync_baseline(frame, frame.last_successful_deploy_at)
        await update_frame(db, redis, frame)
        db.refresh(frame)
        sync_status = _build_frame_sync_status(frame, remote_frame)
        repaired_baseline = True
    response: dict[str, Any] = {"sync": sync_status}
    if repaired_baseline:
        response["frame"] = frame.to_dict()
    return response


@api_project.post("/frames/{id:int}/sync")
async def api_frame_sync_apply(
    id: int,
    data: FrameSyncApplyRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    remote_frame = await _load_live_frame_api_payload(frame, redis)
    backend_frame = frame.to_dict()
    frame_json_choices = _sync_item_choices(
        data.frame_json_choices,
        data.frame_json or "ignore",
        _changed_frame_sync_keys(backend_frame, remote_frame),
    )
    scenes_json_choices = _sync_item_choices(
        data.scenes_json_choices,
        data.scenes_json or "ignore",
        _changed_scene_sync_keys(backend_frame, remote_frame),
    )
    if not frame_json_choices and not scenes_json_choices:
        _bad_request("Choose at least one change to sync")

    backend_push_payload: dict[str, Any] = {}
    database_changed = False

    frame_import = {
        key: _sync_frame_value(key, remote_frame.get(key))
        for key, choice in frame_json_choices.items()
        if choice == "frame" and key in FRAME_SYNC_FRAME_KEYS
    }
    if frame_import:
        for key in FRAME_SYNC_SECRET_KEYS:
            if frame_import.get(key) in (None, "") and getattr(frame, key, None):
                frame_import.pop(key, None)
        try:
            _apply_sync_frame_update(frame, frame_import)
        except ValueError as exc:
            _bad_request(str(exc))
        database_changed = True

    for key, choice in frame_json_choices.items():
        if choice == "backend" and key in FRAME_SYNC_FRAME_KEYS:
            backend_push_payload[key] = _sync_frame_value(key, backend_frame.get(key))

    if scenes_json_choices:
        remote_scenes = remote_frame.get("scenes")
        if not isinstance(remote_scenes, list):
            _bad_request("Frame scenes payload is invalid")
        backend_scenes, frame_scenes = _apply_scene_sync_choices(
            backend_frame.get("scenes"),
            remote_scenes,
            scenes_json_choices,
        )
        if not _sync_values_equal(backend_scenes, backend_frame.get("scenes")):
            frame.scenes = backend_scenes
            database_changed = True
        if not _sync_values_equal(frame_scenes, remote_scenes):
            backend_push_payload["scenes"] = frame_scenes

    if database_changed:
        await update_frame(db, redis, frame)
        db.refresh(frame)

    if backend_push_payload:
        await _push_frame_sync_payload(frame, redis, backend_push_payload, reload_runtime=True)

    remote_after = await _load_live_frame_api_payload(frame, redis)
    sync_status = _build_frame_sync_status(frame, remote_after)
    if not sync_status["has_changes"]:
        _mark_frame_sync_baseline(frame)
        await update_frame(db, redis, frame)
        db.refresh(frame)
        await _push_frame_sync_metadata(frame, redis)
        remote_after["last_successful_deploy_at"] = _serialize_datetime(frame.last_successful_deploy_at)
        remote_after["last_successful_deploy"] = frame.last_successful_deploy
        sync_status = _build_frame_sync_status(frame, remote_after)

    latest_log_at = (
        db.query(func.max(Log.timestamp))
        .filter_by(project_id=frame.project_id, frame_id=frame.id)
        .filter(_frame_activity_log_filter())
        .scalar()
    )
    return {
        "message": "Frame sync applied",
        "sync": sync_status,
        "frame": _frame_to_response_dict(frame, latest_log_at),
    }


@api_project.get("/frames/{id:int}/logs", response_model=FrameLogsResponse)
async def api_frame_get_logs(
    id: int,
    after_id: Optional[int] = Query(None, ge=0),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    if after_id is not None:
        # Incremental fetch: only rows newer than what the client already has.
        # Used on websocket reconnect so a flaky connection doesn't re-download
        # the whole buffer every time. Ascending so callers can append directly.
        rows = (
            db.query(Log)
            .filter(Log.project_id == frame.project_id, Log.frame_id == id, Log.id > after_id)
            .order_by(Log.id.asc())
            .limit(1000)
            .all()
        )
        return {"logs": [log_entry.to_dict() for log_entry in rows]}
    latest_logs = (
        db.query(Log)
        .filter_by(project_id=frame.project_id, frame_id=id)
        .order_by(Log.timestamp.desc(), Log.id.desc())
        .limit(1000)
        .all()
    )
    logs = [log_entry.to_dict() for log_entry in reversed(latest_logs)]
    return {"logs": logs}


def _format_frame_log_line(log_entry: Log) -> str:
    timestamp = log_entry.timestamp.replace(tzinfo=timezone.utc).isoformat()
    return f"[{timestamp}] ({log_entry.type}) {log_entry.line}"


@api_project.get("/frames/{id:int}/logs/full")
async def api_frame_download_full_logs(id: int, db: Session = Depends(get_db)):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    logs = (
        db.query(Log)
        .filter_by(project_id=frame.project_id, frame_id=id)
        .order_by(Log.timestamp.asc(), Log.id.asc())
        .all()
    )
    content = "\n".join(_format_frame_log_line(log_entry) for log_entry in logs)
    if content:
        content += "\n"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    filename = f"frame-{id}-full-logs-{timestamp}.log"
    return Response(
        content,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{_ascii_safe(filename)}"; '
                f"filename*=UTF-8''{quote(filename, safe='')}"
            ),
        },
    )


@api_open.api_route("/projects/{project_id}/frames/{id:int}/image", methods=["GET", "HEAD"])
async def api_frame_get_image(
    project_id: int,
    id: int,
    request: Request,
    token: str | None = None,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = await _public_project_frame(
        project_id=project_id,
        frame_id=id,
        request=request,
        db=db,
        token=token,
    )

    cache_key = _frame_image_cache_key(frame.id)
    path = "/image"

    if request.method == "HEAD":
        headers = await _read_frame_sync_hint_headers(redis, frame.id)
        if not await _get_cached_frame_image(redis, cache_key):
            headers.update(FRAME_IMAGE_PLACEHOLDER_HEADERS)
        return Response(content=b"", media_type="image/png", headers=headers)

    if request.query_params.get("t") == "-1":
        last_image = await _get_cached_frame_image(redis, cache_key)
        if last_image:
            return Response(
                content=last_image,
                media_type="image/png",
                headers=await _read_frame_sync_hint_headers(redis, frame.id),
            )
        else:
            return await _frame_image_placeholder_response(frame)

    frame_image_lock = _get_frame_image_lock(id)
    waited_for_lock = frame_image_lock.locked()
    if waited_for_lock:
        cached = await _wait_for_cached_frame_image(redis, cache_key)
        if cached:
            return Response(
                content=cached,
                media_type="image/png",
                headers=await _read_frame_sync_hint_headers(redis, frame.id),
            )
        return await _frame_image_placeholder_response(frame)

    async with frame_image_lock:
        cached = await _get_cached_frame_image(redis, cache_key)
        refresh_lock_key = _frame_image_refresh_lock_key(id)
        refresh_lock_token = f"{config.INSTANCE_ID}:{time.time()}:{id}"
        refresh_lock_acquired = await redis.set(
            refresh_lock_key,
            refresh_lock_token,
            ex=FRAME_IMAGE_REFRESH_LOCK_SECONDS,
            nx=True,
        )
        if not refresh_lock_acquired:
            cached = await _wait_for_cached_frame_image(redis, cache_key)
            if cached:
                return Response(
                    content=cached,
                    media_type="image/png",
                    headers=await _read_frame_sync_hint_headers(redis, frame.id),
                )
            return await _frame_image_placeholder_response(frame)

        # Use shared semaphore and client
        status = 0
        body = b""
        try:
            status, body, headers = await _fetch_frame_http_bytes(
                frame, redis, path=path
            )

            if status == 200:
                body = await asyncio.get_running_loop().run_in_executor(
                    None, _coerce_frame_image_to_png, body, headers
                )
                scene_id = headers.get("x-scene-id")
                if not scene_id:
                    encoded_scene_id = await redis.get(f"frame:{id}:active_scene")
                    if encoded_scene_id:
                        scene_id = encoded_scene_id.decode("utf-8")
                await _store_frame_image(db, redis, frame, body, scene_id=scene_id, publish_rendered=False)
                response_headers = await _store_frame_sync_hint_headers(redis, frame.id, headers)

                return Response(content=body, media_type="image/png", headers=response_headers)
            else:
                if cached:
                    return Response(
                        content=cached,
                        media_type="image/png",
                        headers=await _read_frame_sync_hint_headers(redis, frame.id),
                    )
                await log(
                    db,
                    redis,
                    id,
                    "stderr",
                    f"Error fetching image from frame {id}: {status} {body.decode(errors='ignore')}",
                )
                return await _frame_image_error_response(frame, "Unable to fetch image", status)

        except httpx.ReadTimeout:
            if cached:
                return Response(
                    content=cached,
                    media_type="image/png",
                    headers=await _read_frame_sync_hint_headers(redis, frame.id),
                )
            await log(
                db,
                redis,
                id,
                "stderr",
                f"Error fetching image from frame {id}: request timeout",
            )
            return await _frame_image_error_response(frame, "Request Timeout", HTTPStatus.REQUEST_TIMEOUT)
        except HTTPException as exc:
            if cached:
                return Response(
                    content=cached,
                    media_type="image/png",
                    headers=await _read_frame_sync_hint_headers(redis, frame.id),
                )
            await log(
                db,
                redis,
                id,
                "stderr",
                f"Error fetching image from frame {id}: {exc.status_code}: {exc.detail}",
            )
            return await _frame_image_error_response(frame, str(exc.detail), exc.status_code)
        except Exception as e:
            if cached:
                return Response(
                    content=cached,
                    media_type="image/png",
                    headers=await _read_frame_sync_hint_headers(redis, frame.id),
                )
            await log(
                db,
                redis,
                id,
                "stderr",
                f"Error fetching image from frame {id}: {str(e)}",
            )
            return await _frame_image_error_response(frame, str(e), HTTPStatus.INTERNAL_SERVER_ERROR)
        finally:
            if refresh_lock_acquired:
                with contextlib.suppress(Exception):
                    await _release_frame_image_refresh_lock(redis, refresh_lock_key, refresh_lock_token)


@api_project.post("/frames/{id:int}/image")
async def api_frame_upload_image(
    id: int,
    request: Request,
    scene_id: str | None = Query(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    body = await request.body()
    if not body:
        _bad_request("Missing image payload")

    headers = {"content-type": request.headers.get("content-type", "")}
    try:
        image_body = await asyncio.get_running_loop().run_in_executor(
            None, _coerce_frame_image_to_png, body, headers
        )
    except Exception as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=f"Not an image: {exc}")

    image_info = await _store_frame_image(db, redis, frame, image_body, scene_id=scene_id)
    return {
        "message": "Frame image updated",
        **image_info,
    }


@api_project.get("/frames/{id:int}/scene_source/{scene}")
async def api_frame_scene_source(id: int, scene: str, db: Session = Depends(get_db)):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    for scene_json in frame.scenes or []:
        if scene_json.get("id") == scene:
            return {"source": write_scene_nim(frame, scene_json)}
    raise HTTPException(
        status_code=HTTPStatus.NOT_FOUND, detail=f"Scene {scene} not found"
    )


async def _load_frame_assets(
    db: Session,
    redis: Redis,
    frame: Frame,
    assets_path: str,
) -> list[dict[str, Any]]:
    if await _use_remote(frame, redis):
        assets = await assets_list_on_frame(frame.id, assets_path, redis=redis)
        assets.sort(key=lambda a: a["path"])
        return assets

    ssh = await get_ssh_connection(db, redis, frame)
    try:
        cmd = f"find {shlex.quote(assets_path)} -exec stat --printf='%F|%s|%Y|%n\\n' {{}} +"
        output: list[str] = []
        await exec_command(db, redis, frame, ssh, cmd, output, log_output=False)
    finally:
        await remove_ssh_connection(db, redis, ssh, frame)

    assets = []
    for line in output:
        if not line:
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        ftype, s, m, p = parts
        if p.strip() != assets_path:
            assets.append({
                "path": p.strip(),
                "size": int(s),
                "mtime": int(m),
                "is_dir": ftype == "directory",
            })
    assets.sort(key=lambda a: a["path"])
    return assets


async def _refresh_frame_assets_cache(
    frame_id: int,
    assets_path: str,
    cache_key: str,
    lock_key: str,
    invalidated_key: str,
    started_at: float,
) -> None:
    redis = create_redis_connection()
    db = SessionLocal()
    completed = False
    try:
        frame = db.get(Frame, frame_id)
        if frame is None:
            return
        assets = await _load_frame_assets(db, redis, frame, assets_path)
        invalidated_at = await redis.get(invalidated_key)
        if invalidated_at:
            invalidated_at = (
                invalidated_at.decode()
                if isinstance(invalidated_at, bytes)
                else invalidated_at
            )
            with contextlib.suppress(TypeError, ValueError):
                if float(invalidated_at) > started_at:
                    completed = True
                    return
        await _write_frame_assets_cache(redis, cache_key, assets)
        completed = True
    except Exception:
        # Keep serving the previous cached list. The lock TTL throttles retries.
        pass
    finally:
        if completed:
            with contextlib.suppress(Exception):
                await redis.delete(lock_key)
        db.close()
        await close_redis_connection(redis)


async def _schedule_frame_assets_cache_refresh(
    redis: Redis,
    frame_id: int,
    assets_path: str,
    cache_key: str,
    lock_key: str,
) -> bool:
    invalidated_key = _frame_assets_cache_invalidated_key(frame_id, assets_path)
    started_at = time.time()
    acquired = await redis.set(
        lock_key,
        "1",
        ex=FRAME_ASSETS_CACHE_LOCK_SECONDS,
        nx=True,
    )
    if acquired:
        _schedule_detached_refresh(
            _refresh_frame_assets_cache(
                frame_id,
                assets_path,
                cache_key,
                lock_key,
                invalidated_key,
                started_at,
            )
        )
    return True


def _frame_assets_cache_meta(
    *,
    cached: bool,
    refreshing: bool,
    fetched_at: float | None,
) -> dict[str, Any]:
    return {
        "cached": cached,
        "refreshing": refreshing,
        "fetched_at": fetched_at,
        "refresh_after": FRAME_ASSETS_CACHE_REFRESH_AFTER_SECONDS,
        "retry_after": FRAME_ASSETS_CACHE_RETRY_AFTER_SECONDS,
    }


@api_project.get("/frames/{id:int}/assets", response_model=FrameAssetsResponse)
async def api_frame_get_assets(
    id: int,
    refresh: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    assets_path = frame.assets_path or "/srv/assets"
    cache_key = _frame_assets_cache_key(frame.id, assets_path)
    lock_key = _frame_assets_cache_lock_key(frame.id, assets_path)
    cached = None if refresh else await _read_frame_assets_cache(redis, cache_key)

    if cached is not None:
        fetched_at = float(cached.get("fetched_at") or 0)
        refreshing = False
        if time.time() - fetched_at >= FRAME_ASSETS_CACHE_REFRESH_AFTER_SECONDS:
            refreshing = await _schedule_frame_assets_cache_refresh(
                redis,
                frame.id,
                assets_path,
                cache_key,
                lock_key,
            )
        return {
            "assets": cached["assets"],
            "cache": _frame_assets_cache_meta(
                cached=True,
                refreshing=refreshing,
                fetched_at=fetched_at,
            ),
        }

    assets = await _load_frame_assets(db, redis, frame, assets_path)
    fetched_at = await _write_frame_assets_cache(redis, cache_key, assets)
    return {
        "assets": assets,
        "cache": _frame_assets_cache_meta(
            cached=False,
            refreshing=False,
            fetched_at=fetched_at,
        ),
    }


@api_project.post("/frames/{id:int}/assets/sync")
async def api_frame_assets_sync(
    id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        from app.models.assets import sync_assets

        await sync_assets(db, redis, frame)
        await _invalidate_frame_assets_cache(redis, frame, frame.assets_path or "/srv/assets")
        return {"message": "Assets synced successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/assets/upload_image")
async def api_frame_assets_upload_image(
    id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    data = await file.read()
    if not data:
        _bad_request("Uploaded file is empty")

    original_name = os.path.basename(file.filename or "image")
    base_name, extension = os.path.splitext(original_name)
    safe_base = _ascii_re.sub("_", base_name).strip("._") or "image"
    safe_extension = _ascii_re.sub("", extension)
    md5sum = hashlib.md5(data).hexdigest()
    filename = f"{safe_base}.{md5sum}{safe_extension}"

    assets_path = frame.assets_path or "/srv/assets"
    upload_dir = os.path.normpath(os.path.join(assets_path, "uploads"))
    combined_path = os.path.normpath(os.path.join(upload_dir, filename))

    if not combined_path.startswith(os.path.normpath(assets_path) + os.sep):
        _bad_request("Invalid asset path")

    await make_dir(db, redis, frame, upload_dir)

    exists_status, _, _ = await run_command(
        db,
        redis,
        frame,
        f"test -f {shlex.quote(combined_path)}",
        log_output=False,
        log_command=False,
    )
    uploaded = False
    if exists_status != 0:
        await upload_file(db, redis, frame, combined_path, data)
        uploaded = True

    if uploaded:
        await _invalidate_frame_assets_cache(redis, frame, assets_path)

    rel = os.path.relpath(combined_path, assets_path)
    return {
        "path": rel,
        "filename": filename,
        "size": len(data),
        "uploaded": uploaded,
    }


@api_project.post("/frames/{id:int}/assets/upload")
async def api_frame_assets_upload(
    id: int,
    path: Optional[str] = Form(
        None,
        description="Sub-folder inside the frame's assets directory (optional)",
    ),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    subdir = (path or "").lstrip("/")
    if "*" in subdir or ".." in subdir or os.path.isabs(subdir):
        _bad_request("Invalid character * in path")

    assets_path = frame.assets_path or "/srv/assets"
    combined_path = os.path.normpath(
        os.path.join(assets_path, subdir, file.filename or "uploaded_file")
    )
    if not combined_path.startswith(os.path.normpath(assets_path) + os.sep):
        _bad_request("Invalid asset path")

    data = await file.read()

    await upload_file(db, redis, frame, combined_path, data)
    await _invalidate_frame_assets_cache(redis, frame, assets_path)

    rel = os.path.relpath(combined_path, assets_path)
    return {
        "path": rel,
        "size": len(data),
        "mtime": int(datetime.now().timestamp()),
        "is_dir": False,
    }


@api_project.post("/frames/{id:int}/assets/mkdir")
async def api_frame_assets_mkdir(
    id: int,
    path: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    rel_path = path.lstrip("/")
    if ".." in rel_path or "*" in rel_path or os.path.isabs(rel_path):
        _bad_request("Invalid asset path")

    assets_path = frame.assets_path or "/srv/assets"
    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    # Trailing separator so "/srv/assets-other" can't pass as "/srv/assets",
    # matching the upload endpoints.
    normalized_assets_path = os.path.normpath(assets_path)
    if full_path != normalized_assets_path and not full_path.startswith(normalized_assets_path + os.sep):
        _bad_request("Invalid asset path")

    await make_dir(db, redis, frame, full_path)
    await _invalidate_frame_assets_cache(redis, frame, assets_path)
    return {"message": "Created"}


@api_project.post("/frames/{id:int}/assets/delete")
async def api_frame_assets_delete(
    id: int,
    path: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    rel_path = path.lstrip("/")
    if ".." in rel_path or "*" in rel_path or os.path.isabs(rel_path):
        _bad_request("Invalid asset path")

    assets_path = frame.assets_path or "/srv/assets"
    full_path = os.path.normpath(os.path.join(assets_path, rel_path))
    # Trailing separator so "/srv/assets-other" can't pass as "/srv/assets",
    # matching the upload endpoints.
    normalized_assets_path = os.path.normpath(assets_path)
    if full_path != normalized_assets_path and not full_path.startswith(normalized_assets_path + os.sep):
        _bad_request("Invalid asset path")

    await delete_path(db, redis, frame, full_path)
    await _invalidate_frame_assets_cache(redis, frame, assets_path)
    return {"message": "Deleted"}


@api_project.post("/frames/{id:int}/assets/rename")
async def api_frame_assets_rename(
    id: int,
    src: str = Form(...),
    dst: str = Form(...),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()

    s_rel = src.lstrip("/")
    d_rel = dst.lstrip("/")
    if any(x in s_rel for x in ["..", "*"]) or os.path.isabs(s_rel):
        _bad_request("Invalid source path")
    if any(x in d_rel for x in ["..", "*"]) or os.path.isabs(d_rel):
        _bad_request("Invalid destination path")

    assets_path = frame.assets_path or "/srv/assets"
    src_full = os.path.normpath(os.path.join(assets_path, s_rel))
    dst_full = os.path.normpath(os.path.join(assets_path, d_rel))
    if not src_full.startswith(
        os.path.normpath(assets_path)
    ) or not dst_full.startswith(os.path.normpath(assets_path)):
        _bad_request("Invalid asset path")

    await rename_path(db, redis, frame, src_full, dst_full)
    await _invalidate_frame_assets_cache(redis, frame, assets_path)
    return {"message": "Renamed"}


@api_project.post("/frames/{id:int}/clear_build_cache")
async def api_frame_clear_build_cache(
    id: int, redis: Redis = Depends(get_redis), db: Session = Depends(get_db)
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    if await _use_remote(frame, redis):
        try:
            await log(
                db,
                redis,
                id,
                "stdout",
                "> rm -rf /srv/frameos/build/cache && echo DONE",
            )
            await exec_shell_on_frame(
                frame.id,
                "rm -rf /srv/frameos/build/cache && echo DONE",
                redis=redis,
            )
            return {"message": "Build cache cleared successfully"}
        except Exception as e:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e)
            )

    try:
        ssh = await get_ssh_connection(db, redis, frame)
        try:
            command = "rm -rf /srv/frameos/build/cache && echo 'Build cache cleared'"
            await exec_command(db, redis, frame, ssh, command)
        finally:
            await remove_ssh_connection(db, redis, ssh, frame)
        return {"message": "Build cache cleared successfully"}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/reset")
async def api_frame_reset_event(
    id: int,
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    try:
        from app.tasks import reset_frame

        await reset_frame(frame.id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/restart")
async def api_frame_restart_event(
    id: int,
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    try:
        from app.tasks import restart_frame

        await restart_frame(frame.id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/reboot")
async def api_frame_reboot_event(
    id: int,
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    try:
        from app.tasks import reboot_frame

        await reboot_frame(frame.id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/deploy_remote")
async def api_frame_deploy_remote_event(
    id: int,
    recompile: bool = False,
    transport: str = "auto",
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    remote_transport = _remote_task_transport(transport)
    try:
        from app.tasks import deploy_remote

        await deploy_remote(frame.id, redis, recompile=recompile, transport=remote_transport)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/restart_remote")
async def api_frame_restart_remote_event(
    id: int,
    transport: str = "auto",
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    remote_transport = _remote_task_transport(transport)
    try:
        from app.tasks import restart_remote

        await restart_remote(frame.id, redis, transport=remote_transport)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/stop")
async def api_frame_stop_event(
    id: int,
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    try:
        from app.tasks import stop_frame

        await stop_frame(frame.id, redis)
        return "Success"
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

@api_project.post("/frames/{id:int}/deploy")
async def api_frame_deploy_event(
    id: int,
    task_id: str | None = Query(None),
    force: bool = Query(False),
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    deploy_task_id = _task_id_param(task_id)
    try:
        from app.tasks import deploy_frame
        from app.tasks.deploy_frame import cancel_active_deploy

        if force:
            await cancel_active_deploy(db, redis, frame)
        await deploy_frame(frame.id, redis, task_id=deploy_task_id)
        return {"message": "Success", "taskId": deploy_task_id}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/cancel_deploy")
async def api_frame_cancel_deploy(
    id: int,
    redis: Redis = Depends(get_redis),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id) or _not_found()
    try:
        from app.tasks.deploy_frame import cancel_active_deploy

        result = await cancel_active_deploy(db, redis, frame)
        return {"message": "Success", **result}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.get("/frames/{id:int}/buildroot/sd_image")
async def api_frame_buildroot_sd_image_status(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "buildroot":
        _bad_request("SD card image generation is only available for Buildroot frames")

    try:
        platform = normalize_buildroot_platform((frame.buildroot or {}).get("platform"))
    except ValueError as exc:
        _bad_request(str(exc))
    base_entry = None
    try:
        base_entry = await resolve_buildroot_base_entry(platform)
    except Exception:
        if not can_use_precompiled_buildroot_sd_image(frame):
            raise
    return {
        "sdImage": await refresh_buildroot_sd_image_status(db, redis, frame, base_entry)
        or {
            "status": "idle",
            "platform": platform,
        }
    }


@api_project.post("/frames/{id:int}/buildroot/sd_image")
async def api_frame_buildroot_sd_image(
    id: int,
    force: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "buildroot":
        _bad_request("SD card image generation is only available for Buildroot frames")

    settings = get_settings_dict(db, project_id=frame.project_id)
    build_environment_provider = selected_build_environment_provider(settings)
    if build_environment_provider == "none" and not can_use_precompiled_buildroot_sd_image(frame):
        _bad_request(
            buildroot_sd_image_no_build_environment_message(
                "precompiled Buildroot SD image mode with no compiled scenes"
            )
        )
    if build_environment_requires_executor_config(build_environment_provider) and get_build_executor_config(db, frame.project_id) is None:
        _bad_request(f"Selected build environment '{build_environment_provider}' is not configured")

    try:
        ensure_buildroot_frame_defaults(frame)
    except ValueError as exc:
        _bad_request(str(exc))

    db.add(frame)
    db.commit()

    try:
        started, sd_image = await start_buildroot_sd_image(db, redis, frame, force=force)
        if started:
            message = "Buildroot SD card image preparation started"
        elif sd_image.get("status") == "ready":
            message = "Buildroot SD card image already ready"
        else:
            message = "Buildroot SD card image preparation already running"
        return {
            "message": message,
            "sdImage": sd_image,
        }
    except ValueError as e:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.get("/frames/{id:int}/buildroot/sd_image/download")
async def api_frame_buildroot_sd_image_download(id: int, db: Session = Depends(get_db)):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "buildroot":
        _bad_request("SD card image downloads are only available for Buildroot frames")

    sd_image = latest_buildroot_sd_image(frame)
    if not sd_image or sd_image.get("status") != "ready":
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="No ready SD card image for this frame")

    path = sd_image.get("path")
    if not isinstance(path, str) or not os.path.isfile(path):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Generated SD card image file not found")

    filename = str(sd_image.get("filename") or f"frameos-{id}.img")
    download_path = path
    download_filename = filename
    if not path.endswith(".gz"):
        download_path = f"{path}.gz"
        download_filename = filename if filename.endswith(".gz") else f"{filename}.gz"
        if not os.path.isfile(download_path) or os.path.getmtime(download_path) < os.path.getmtime(path):
            with open(path, "rb") as source, open(download_path, "wb") as compressed:
                with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as destination:
                    shutil.copyfileobj(source, destination)

    return FileResponse(download_path, media_type="application/gzip", filename=download_filename)


@api_project.get("/frames/{id:int}/embedded/firmware")
async def api_frame_embedded_firmware_status(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "embedded":
        _bad_request("Firmware generation is only available for embedded frames")

    try:
        platform = normalize_embedded_platform((frame.embedded or {}).get("platform"))
        firmware = await refresh_embedded_firmware_status(db, redis, frame)
        flash_size = embedded_flash_size_for_frame(frame)
        ota_supported = embedded_ota_supported_for_frame(frame)
    except ValueError as exc:
        _bad_request(str(exc))
    return {
        "firmware": firmware
        or with_embedded_firmware_layout(frame, {
            "status": "idle",
            "platform": platform,
            "flashSize": flash_size,
            "otaSupported": ota_supported,
        })
    }


@api_project.post("/frames/{id:int}/embedded/firmware")
async def api_frame_embedded_firmware(
    id: int,
    force: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "embedded":
        _bad_request("Firmware generation is only available for embedded frames")
    if not embedded_toolchain_available():
        _bad_request(
            "ESP-IDF toolchain not found on the backend. "
            "Install it and set IDF_PATH (see embedded/esp32/README.md)."
        )

    try:
        ensure_embedded_frame_defaults(frame)
    except ValueError as exc:
        _bad_request(str(exc))

    db.add(frame)
    db.commit()

    try:
        started, firmware = await start_embedded_firmware(db, redis, frame, force=force)
        if started:
            message = "Firmware build started"
        elif firmware.get("status") == "ready":
            message = "Firmware already ready"
        else:
            message = "Firmware build already running"
        return {
            "message": message,
            "firmware": firmware,
        }
    except ValueError as e:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.get("/frames/{id:int}/embedded/firmware/download")
async def api_frame_embedded_firmware_download(id: int, db: Session = Depends(get_db)):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "embedded":
        _bad_request("Firmware downloads are only available for embedded frames")

    firmware = latest_embedded_firmware(frame)
    if not firmware or firmware.get("status") != "ready":
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="No ready firmware image for this frame")

    path = firmware.get("path")
    if not isinstance(path, str) or not os.path.isfile(path):
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Generated firmware file not found")

    filename = str(firmware.get("filename") or f"frameos-esp32-{id}.bin")
    return FileResponse(path, media_type="application/octet-stream", filename=filename)


@api_project.post("/frames/{id:int}/embedded/firmware/ota")
async def api_frame_embedded_firmware_ota(
    id: int,
    force: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()
    if (frame.mode or "rpios") != "embedded":
        _bad_request("OTA updates are only available for embedded frames")

    try:
        message, firmware, device_payload = await request_or_queue_embedded_firmware_ota(
            db,
            redis,
            frame,
            force=force,
        )
    except ValueError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc))

    return {
        "message": message,
        "firmware": firmware,
        "device": device_payload,
    }


@api_project.get("/frames/{id:int}/deploy_plan")
async def api_frame_deploy_plan(
    id: int,
    mode: str = Query("combined"),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()

    try:
        if mode in {"combined", "full"}:
            with tempfile.TemporaryDirectory() as temp_dir:
                deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir=temp_dir)
                workflow = FrameDeployWorkflow(
                    db=db,
                    redis=redis,
                    frame=frame,
                    deployer=deployer,
                    temp_dir=temp_dir,
                )
                plan = await workflow.plan(mode)
        elif mode == "fast":
            deployer = FrameDeployer(db=db, redis=redis, frame=frame, nim_path="", temp_dir="")
            workflow = FrameDeployWorkflow(
                db=db,
                redis=redis,
                frame=frame,
                deployer=deployer,
                temp_dir="",
            )
            plan = await workflow.plan("fast")
        else:
            _bad_request("mode must be 'combined', 'full' or 'fast'")

        return {"plan": plan.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/deploy_plan")
async def api_frame_deploy_plan_preview(
    id: int,
    data: FrameUpdateRequest,
    mode: str = Query("combined"),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()

    preview_frame = _apply_frame_preview_update(frame, data)
    preview_ssh_user_before_plan = preview_frame.ssh_user

    try:
        if mode in {"combined", "full"}:
            with tempfile.TemporaryDirectory() as temp_dir:
                deployer = FrameDeployer(db=db, redis=redis, frame=preview_frame, nim_path="", temp_dir=temp_dir)
                workflow = FrameDeployWorkflow(
                    db=db,
                    redis=redis,
                    frame=preview_frame,
                    deployer=deployer,
                    temp_dir=temp_dir,
                )
                plan = await workflow.plan(mode)
        elif mode == "fast":
            deployer = FrameDeployer(db=db, redis=redis, frame=preview_frame, nim_path="", temp_dir="")
            workflow = FrameDeployWorkflow(
                db=db,
                redis=redis,
                frame=preview_frame,
                deployer=deployer,
                temp_dir="",
            )
            plan = await workflow.plan("fast")
        else:
            _bad_request("mode must be 'combined', 'full' or 'fast'")

        frame_settings_changed = False
        if preview_frame.mode != frame.mode and preview_frame.mode in {"rpios", "buildroot"}:
            frame.mode = preview_frame.mode
            frame_settings_changed = True
        if preview_frame.ssh_user != preview_ssh_user_before_plan and preview_frame.ssh_user != frame.ssh_user:
            frame.ssh_user = preview_frame.ssh_user
            frame_settings_changed = True
        if frame_settings_changed:
            await update_frame(db, redis, frame)

        return {"plan": plan.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/fast_deploy")
async def api_frame_fast_deploy_event(
    id: int,
    task_id: str | None = Query(None),
    force: bool = Query(False),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    deploy_task_id = _task_id_param(task_id)
    try:
        from app.tasks import fast_deploy_frame
        from app.tasks.deploy_frame import cancel_active_deploy

        if force:
            await cancel_active_deploy(db, redis, frame)
        await fast_deploy_frame(id, redis, task_id=deploy_task_id)
        return {"message": "Success", "taskId": deploy_task_id}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/embedded/usb_deploy_complete")
async def api_frame_embedded_usb_deploy_complete(
    id: int,
    task_id: str | None = Query(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id) or _not_found()
    if (frame.mode or "rpios") != "embedded":
        _bad_request("USB deploy completion is only available for embedded frames")

    snapshot = frame.to_dict()
    snapshot.pop("last_successful_deploy", None)
    snapshot.pop("last_successful_deploy_at", None)
    frameos_version = current_frameos_version()
    if isinstance(frameos_version, str) and frameos_version:
        snapshot["frameos_version"] = frameos_version
    frame.status = "starting"
    frame.last_successful_deploy = snapshot
    frame.last_successful_deploy_at = datetime.now(timezone.utc)
    await update_frame(db, redis, frame)
    await log(
        db,
        redis,
        id,
        "stdinfo",
        "Embedded USB fast deploy complete; reload queued",
    )
    if task_id:
        await log(
            db,
            redis,
            id,
            "stdout",
            f"[frameos-task:{_task_id_param(task_id)}] deploy completed fast",
        )
    return {"message": "Success", "frame": frame.to_dict()}


@api_project.post("/frames/{id:int}/set_next_scene")
async def api_frame_set_next_scene(
    id: int,
    data: FrameSetNextSceneRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        _not_found()

    if not any(scene.get("id") == data.sceneId for scene in (frame.scenes or [])):
        _bad_request(f"Scene {data.sceneId} not found on frame")

    if data.state is not None and not isinstance(data.state, dict):
        _bad_request("State must be an object")

    state_dir = _frame_state_dir(frame)
    await make_dir(db, redis, frame, state_dir)

    scene_payload = {"sceneId": data.sceneId}
    state_payload = data.state or {}
    scene_state_path = os.path.join(
        state_dir, f"scene-{_sanitize_scene_state_filename(data.sceneId)}.json"
    )

    await upload_file(
        db,
        redis,
        frame,
        os.path.join(state_dir, "scene.json"),
        (json.dumps(scene_payload, indent=2) + "\n").encode("utf-8"),
    )
    await upload_file(
        db,
        redis,
        frame,
        scene_state_path,
        (json.dumps(state_payload, indent=2) + "\n").encode("utf-8"),
    )

    try:
        if data.fastDeploy:
            from app.tasks import fast_deploy_frame

            await fast_deploy_frame(id, redis)
        else:
            from app.tasks import deploy_frame

            await deploy_frame(id, redis)
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))

    return {"message": "Next scene queued for boot"}


@api_project.post("/frames/{id:int}")
async def api_frame_update_endpoint(
    id: int,
    data: FrameUpdateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    update_data = data.model_dump(exclude_unset=True)
    previous_buildroot_sd_image_fingerprint = (
        buildroot_sd_image_config_fingerprint(frame)
        if (frame.mode or "rpios") == "buildroot"
        else ""
    )
    if isinstance(update_data.get("scenes"), str):
        try:
            update_data["scenes"] = json.loads(update_data["scenes"])
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid input for scenes (must be JSON)")

    old_mode = frame.mode
    for field, value in update_data.items():
        setattr(frame, field, value)

    if "timezone" in update_data:
        frame.timezone = stored_timezone(frame.timezone) or None
    if "timezone_updater" in update_data:
        frame.timezone_updater = compact_timezone_updater(frame.timezone_updater)

    if "https_proxy" in update_data:
        frame.https_proxy = normalize_https_proxy(frame.https_proxy)
        refresh_tls_certificate_validity_dates(frame)
    if "error_behavior" in update_data:
        frame.error_behavior = normalize_error_behavior(frame.error_behavior)

    if data.mode == "buildroot" or ((frame.mode or "rpios") == "buildroot" and "buildroot" in update_data):
        try:
            ensure_buildroot_frame_defaults(frame, (frame.buildroot or {}).get("platform"))
        except ValueError as exc:
            _bad_request(str(exc))
    elif data.mode == "embedded" or (frame.mode or "rpios") == "embedded":
        try:
            ensure_embedded_frame_defaults(frame, (frame.embedded or {}).get("platform"))
        except ValueError as exc:
            _bad_request(str(exc))
    elif data.mode == "rpios" and old_mode == "buildroot" and frame.ssh_user == "root":
        frame.ssh_user = "pi"

    if (
        (frame.mode or "rpios") == "buildroot"
        and previous_buildroot_sd_image_fingerprint
        and buildroot_sd_image_config_fingerprint(frame) != previous_buildroot_sd_image_fingerprint
    ):
        clear_buildroot_sd_image(frame)

    await update_frame(db, redis, frame)

    if data.next_action == "restart":
        from app.tasks import restart_frame

        await restart_frame(id, redis)
    elif data.next_action == "reboot":
        from app.tasks import reboot_frame

        await reboot_frame(id, redis)
    elif data.next_action == "stop":
        from app.tasks import stop_frame

        await stop_frame(id, redis)
    elif data.next_action == "deploy":
        from app.tasks import deploy_frame

        await deploy_frame(id, redis)

    return {"message": "Frame updated successfully"}




@api_project.post("/frames/{id:int}/tls/generate")
async def api_frame_generate_tls_material_endpoint(
    id: int,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    material = generate_frame_tls_material(frame.frame_host or "")
    server_not_valid_after = parse_certificate_not_valid_after(material["server"])
    client_ca_not_valid_after = parse_certificate_not_valid_after(material["client_ca"])

    return {
        "certs": {
            "server": material["server"],
            "server_key": material["server_key"],
            "client_ca": material["client_ca"],
        },
        "server_cert_not_valid_after": _serialize_datetime(server_not_valid_after),
        "client_ca_cert_not_valid_after": _serialize_datetime(client_ca_not_valid_after),
    }


@api_project.post("/frames/new", response_model=FrameResponse)
async def api_frame_new(
    data: FrameCreateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    project_id = current_project_id()
    settings = get_settings_dict(db, project_id=project_id)
    try:
        if data.mode == "buildroot":
            normalize_buildroot_platform(data.platform)
            validate_buildroot_network(data.network)
        elif data.mode == "embedded":
            normalize_embedded_platform(data.platform)

        frame = await new_frame(
            db,
            redis,
            data.name,
            data.frame_host,
            data.server_host,
            data.device,
            data.interval,
            project_id=project_id,
        )
        if data.device_config is not None:
            frame.device_config = dict(data.device_config)
        if data.embedded is not None:
            frame.embedded = dict(data.embedded)

        if data.ssh_keys is not None:
            frame.ssh_keys = list(dict.fromkeys([key for key in data.ssh_keys if key]))
        else:
            frame.ssh_keys = default_ssh_key_ids(settings) or None
        frame.ssh_pass = data.ssh_pass

        frame.mode = data.mode or "rpios"
        if frame.mode == "buildroot":
            frame.timezone = frame_timezone(data.timezone, (settings.get("defaults") or {}).get("timezone"))
            frame.network = {
                **(frame.network or {}),
                **(data.network or {}),
            }
            ensure_buildroot_frame_defaults(frame, data.platform)
            validate_buildroot_wifi_credentials(frame)
            db.add(frame)
            db.commit()
            db.refresh(frame)
        elif frame.mode == "embedded":
            frame.timezone = frame_timezone(data.timezone, (settings.get("defaults") or {}).get("timezone"))
            if data.network:
                frame.network = {
                    **(frame.network or {}),
                    **data.network,
                }
            ensure_embedded_frame_defaults(frame, data.platform)
            db.add(frame)
            db.commit()
            db.refresh(frame)
        else:
            frame.timezone = normalize_timezone(data.timezone) or None
            rpios_settings = {**(frame.rpios or {})}
            rpios_settings["platform"] = data.platform or (frame.rpios or {}).get('platform') or ''
            frame.rpios = rpios_settings
            if data.agent:
                frame.agent = {
                    **(frame.agent or {}),
                    **data.agent,
                }
            db.add(frame)
            db.commit()
            db.refresh(frame)

        return {"frame": frame.to_dict()}
    except ValueError as e:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.post("/frames/{id:int}/ssh_keys")
async def api_frame_update_ssh_keys(
    id: int,
    data: FrameSSHKeysUpdateRequest,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    frame = _project_frame(db, id)
    if not frame:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")

    settings = get_settings_dict(db, project_id=frame.project_id)
    try:
        new_keys, public_keys, known_public_keys = resolve_authorized_keys_update(
            data.ssh_keys,
            frame.ssh_keys,
            settings,
        )
        await _install_authorized_keys(db, redis, frame, public_keys, known_public_keys)
    except ValueError as exc:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=str(exc))
    frame.ssh_keys = new_keys
    if (frame.mode or "rpios") == "buildroot":
        clear_buildroot_sd_image(frame)
    await update_frame(db, redis, frame)

    return {"message": "SSH keys updated successfully"}


@api_project.post("/frames/import", response_model=FrameResponse)
async def api_frame_import(
    request: Request,
    file: UploadFile = File(None),
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
):
    """Import a frame from a JSON body or uploaded file."""
    try:
        if file is not None:
            content = await file.read()
            data = json.loads(content)
        else:
            data = await request.json()
    except Exception:
        raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail="Invalid JSON")

    try:
        frame = await new_frame(
            db,
            redis,
            data.get("name"),
            data.get("frame_host"),
            data.get("server_host"),
            data.get("device"),
            data.get("interval"),
            project_id=current_project_id(),
        )

        for key, value in data.items():
            if key in [
                "id",
                "project_id",
                "name",
                "frame_host",
                "server_host",
                "device",
                "interval",
                "last_success",
            ]:
                continue
            if hasattr(frame, key):
                if key == "server_api_key":
                    if not value or db.query(Frame).filter(Frame.server_api_key == value, Frame.id != frame.id).first():
                        continue
                if key in ["last_successful_deploy_at", "last_log_at"]:
                    value = datetime.fromisoformat(value) if isinstance(value, str) else value
                setattr(frame, key, value)

        await update_frame(db, redis, frame)
        db.refresh(frame)

        return {"frame": frame.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.delete("/frames/{frame_id}")
async def api_frame_delete(
    frame_id: int, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)
):
    _project_frame(db, frame_id)
    success = await delete_frame(db, redis, frame_id, current_project_id())
    if success:
        return {"message": "Frame deleted successfully"}
    else:
        raise HTTPException(status_code=404, detail="Frame not found")


REBOOT_CONTEXT_LOOKBACK = timedelta(minutes=30)


def _json_log_payload(line: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(line)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _reboot_kind_from_service_result(service_result: str | None) -> str | None:
    if not service_result:
        return None
    if service_result == "oom-kill":
        return "oom"
    if service_result == "watchdog":
        return "watchdog"
    if service_result == "success":
        return "initiated"
    return "error"


def _reboot_details_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    reboot = payload.get("reboot")
    if not isinstance(reboot, dict):
        return {}

    details: dict[str, Any] = {}
    field_map = {
        "bootId": "boot_id",
        "boot_id": "boot_id",
        "previousBootId": "previous_boot_id",
        "previous_boot_id": "previous_boot_id",
        "kind": "kind",
        "reason": "reason",
        "source": "source",
        "message": "message",
        "error": "error",
        "serviceResult": "service_result",
        "service_result": "service_result",
        "exitCode": "exit_code",
        "exit_code": "exit_code",
        "exitStatus": "exit_status",
        "exit_status": "exit_status",
    }
    for source_key, target_key in field_map.items():
        value = reboot.get(source_key)
        if value is not None and value != "":
            details[target_key] = str(value)

    if "kind" not in details:
        kind = _reboot_kind_from_service_result(details.get("service_result"))
        if kind:
            details["kind"] = kind
    return details


def _line_without_prompt(line: str) -> str:
    return line[2:].strip() if line.startswith("> ") else line.strip()


def _reboot_hint_from_log(log: Log) -> dict[str, Any] | None:
    line = _line_without_prompt(log.line)
    lower = line.lower()

    if any(token in lower for token in ("oom-kill", "oom killer", "out of memory", "killed process")):
        return {"kind": "oom", "reason": "OOM restart", "source": "system", "message": line}

    if "reload failed" in lower or "reload request failed" in lower:
        return {"kind": "error", "reason": "Reload error triggered FrameOS restart", "source": "backend", "error": line}

    if log.type == "stderr" or any(token in lower for token in (" failed", " error", "exception")):
        return {"kind": "error", "reason": "Error before restart", "source": "backend", "error": line}

    if "rebooting device" in lower:
        return {"kind": "initiated", "reason": line, "source": "backend", "message": line}

    if line in {"sudo reboot", "/sbin/shutdown -r now", "sudo shutdown -r now"} or "systemctl reboot" in lower:
        return {"kind": "initiated", "reason": "Device reboot requested", "source": "backend", "message": line}

    if "restarting frameos" in lower or line in {
        "sudo systemctl restart frameos.service",
        "systemctl restart frameos.service",
        "sudo systemctl start frameos.service",
    }:
        return {"kind": "initiated", "reason": "FrameOS restart requested", "source": "backend", "message": line}

    return None


def _reboot_hint_for_boot(logs_before_boot: list[Log]) -> dict[str, Any]:
    for log in reversed(logs_before_boot):
        hint = _reboot_hint_from_log(log)
        if hint:
            return hint
    return {}


def _merge_reboot_details(primary: dict[str, Any], secondary: dict[str, Any]) -> dict[str, Any]:
    if not secondary:
        return primary
    merged = {**primary}
    primary_kind = primary.get("kind")
    secondary_kind = secondary.get("kind")
    if not primary_kind or primary_kind in {"initiated", "clean", "unknown"} or secondary_kind in {"oom", "error"}:
        merged.update(secondary)
    return merged


def _frame_reboot_markers(db: Session, frame: Frame, since: Optional[datetime] = None) -> list[dict[str, Any]]:
    query = db.query(Log).filter_by(project_id=frame.project_id, frame_id=frame.id)
    if since is not None:
        since_utc = since.astimezone(timezone.utc) if since.tzinfo else since.replace(tzinfo=timezone.utc)
        query = query.filter(Log.timestamp >= (since_utc - REBOOT_CONTEXT_LOOKBACK).replace(tzinfo=None))

    markers: list[dict[str, Any]] = []
    context_logs: list[Log] = []
    for log_entry in query.order_by(Log.timestamp).all():
        payload = _json_log_payload(log_entry.line) if log_entry.type == "webhook" else None
        if payload and payload.get("event") == "bootup":
            details = _reboot_details_from_payload(payload)
            lookback_start = log_entry.timestamp - REBOOT_CONTEXT_LOOKBACK
            nearby_context = [log for log in context_logs if log.timestamp >= lookback_start]
            details = _merge_reboot_details(details, _reboot_hint_for_boot(nearby_context))
            timestamp = log_entry.timestamp
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            else:
                timestamp = timestamp.astimezone(timezone.utc)
            markers.append(
                {
                    "timestamp": timestamp.isoformat(),
                    "log_id": log_entry.id,
                    **details,
                }
            )
        context_logs.append(log_entry)
        if len(context_logs) > 200:
            context_logs = context_logs[-200:]

    if since is not None:
        since_utc = since.astimezone(timezone.utc) if since.tzinfo else since.replace(tzinfo=timezone.utc)
        return [
            marker
            for marker in markers
            if datetime.fromisoformat(marker["timestamp"]).astimezone(timezone.utc) >= since_utc
        ]
    return markers


@api_project.get("/frames/{id:int}/metrics", response_model=FrameMetricsResponse)
async def api_frame_metrics(id: int, db: Session = Depends(get_db)):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        metrics = db.query(Metrics).filter_by(project_id=frame.project_id, frame_id=id).order_by(Metrics.timestamp).all()
        return {"metrics": [metric.to_dict() for metric in metrics], "reboots": _frame_reboot_markers(db, frame)}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))


@api_project.get("/frames/{id:int}/metrics/recent", response_model=FrameMetricsResponse)
async def api_frame_recent_metrics(
    id: int,
    limit: int = Query(1000, ge=1, le=1000),
    since: Optional[datetime] = Query(None),
    db: Session = Depends(get_db),
):
    frame = _project_frame(db, id)
    if frame is None:
        raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="Frame not found")
    try:
        query = db.query(Metrics).filter_by(project_id=frame.project_id, frame_id=id)
        if since is not None:
            since_utc = since.astimezone(timezone.utc) if since.tzinfo else since.replace(tzinfo=timezone.utc)
            query = query.filter(Metrics.timestamp >= since_utc.replace(tzinfo=None))
        metrics = query.order_by(Metrics.timestamp.desc()).limit(limit).all()
        return {"metrics": [metric.to_dict() for metric in reversed(metrics)], "reboots": _frame_reboot_markers(db, frame, since)}
    except Exception as e:
        raise HTTPException(status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(e))
