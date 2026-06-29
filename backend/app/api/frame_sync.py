from __future__ import annotations

import copy
from datetime import datetime, timezone
from http import HTTPStatus
import json
import re
import uuid
from typing import Any, Awaitable, Callable

from arq import ArqRedis as Redis
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.frame import (
    Frame,
    compact_timezone_updater,
    normalize_frame_admin_auth,
    normalize_error_behavior,
    normalize_https_proxy,
    refresh_tls_certificate_validity_dates,
    update_frame,
)
from app.schemas.frames import FrameSyncApplyRequest, FrameUpdateRequest
from app.tasks.buildroot_image import (
    buildroot_sd_image_config_fingerprint,
    clear_buildroot_sd_image,
    ensure_buildroot_frame_defaults,
)
from app.tasks.embedded_firmware import ensure_embedded_frame_defaults
from app.utils.timezone import stored_timezone
from app.utils.versions import current_frameos_version

FrameFetch = Callable[..., Awaitable[tuple[int, bytes, dict[str, Any]]]]

FRAME_SYNC_IMAGE_HEADER_NAMES = (
    "X-FrameOS-Sync-Changed",
    "X-FrameOS-Sync-Revision",
    "X-FrameOS-Deployed-Revision",
    "X-FrameOS-Frame-Config-Modified-At",
    "X-FrameOS-Scenes-Modified-At",
    "X-FrameOS-Last-Successful-Deploy-At",
    "X-FrameOS-Sync-Checked-At",
)
FRAME_SYNC_HINT_CACHE_TTL_SECONDS = 86400 * 30


def _bad_request(detail: str) -> None:
    raise HTTPException(status_code=HTTPStatus.BAD_REQUEST, detail=detail)


def _decode_bytes(body: bytes) -> str:
    return body.decode("utf-8", errors="replace")


def _serialize_datetime(value: datetime | None) -> str | None:
    if not value:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat()


def _frame_sync_hint_cache_key(frame_id: int) -> str:
    return f"frame:{frame_id}:sync_hint"


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


async def read_frame_sync_hint_headers(redis: Redis, frame_id: int) -> dict[str, str]:
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


async def store_frame_sync_hint_headers(redis: Redis, frame_id: int, frame_headers: dict[str, Any]) -> dict[str, str]:
    changed = _header_value(frame_headers, "x-frameos-sync-changed")
    if changed not in ("0", "1"):
        return await read_frame_sync_hint_headers(redis, frame_id)

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

    await redis.set(_frame_sync_hint_cache_key(frame_id), json.dumps(payload), ex=FRAME_SYNC_HINT_CACHE_TTL_SECONDS)
    return _sync_hint_headers_from_payload(payload)


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


async def _load_live_frame_api_payload(
    frame: Frame, redis: Redis, fetch_frame_http_bytes: FrameFetch
) -> dict[str, Any]:
    headers = await _frame_admin_session_headers(frame, redis, fetch_frame_http_bytes)
    last_status = 0
    last_body = b""
    for path in ("/api/frames/1", f"/api/frames/{frame.id}", "/api/frames"):
        status, body, _headers = await fetch_frame_http_bytes(frame, redis, path=path, headers=headers)
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


async def _frame_admin_session_headers(
    frame: Frame, redis: Redis, fetch_frame_http_bytes: FrameFetch
) -> dict[str, str]:
    auth = normalize_frame_admin_auth(frame.frame_admin_auth)
    username = str(auth.get("user") or "").strip()
    password = str(auth.get("pass") or "").strip()
    if not auth.get("enabled") or not username or not password:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Frame admin credentials are required before syncing from the backend",
        )
    status, body, headers = await fetch_frame_http_bytes(
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


def _frame_sync_baseline(frame: Frame, backend_frame: dict[str, Any]) -> dict[str, Any]:
    if isinstance(frame.last_successful_deploy, dict):
        return frame.last_successful_deploy
    return backend_frame


def _build_frame_sync_section(
    backend_frame: dict[str, Any],
    remote_frame: dict[str, Any],
    baseline_frame: dict[str, Any] | None = None,
) -> dict[str, Any]:
    baseline_frame = baseline_frame or backend_frame
    changes: list[dict[str, Any]] = []
    for key in FRAME_SYNC_FRAME_KEYS:
        backend_value = _sync_frame_value(key, backend_frame.get(key))
        frame_value = _sync_frame_value(key, remote_frame.get(key))
        baseline_value = _sync_frame_value(key, baseline_frame.get(key))
        if _sync_values_equal(frame_value, baseline_value):
            continue
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


def _scene_sync_values_equal(first: Any, second: Any) -> bool:
    return _sync_values_equal(_scene_compare_value(first), _scene_compare_value(second))


def _build_scene_sync_section(
    backend_frame: dict[str, Any],
    remote_frame: dict[str, Any],
    baseline_frame: dict[str, Any] | None = None,
) -> dict[str, Any]:
    backend_scenes = _scenes_by_id(backend_frame.get("scenes"))
    frame_scenes = _scenes_by_id(remote_frame.get("scenes"))
    baseline_scenes = _scenes_by_id((baseline_frame or backend_frame).get("scenes"))
    changes: list[dict[str, Any]] = []
    for scene_id in sorted(set(backend_scenes.keys()) | set(frame_scenes.keys()) | set(baseline_scenes.keys())):
        backend_scene = backend_scenes.get(scene_id)
        frame_scene = frame_scenes.get(scene_id)
        baseline_scene = baseline_scenes.get(scene_id)
        if _scene_sync_values_equal(frame_scene, baseline_scene):
            continue
        if _scene_sync_values_equal(frame_scene, backend_scene):
            continue
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


def _changed_frame_sync_keys(
    backend_frame: dict[str, Any],
    remote_frame: dict[str, Any],
    baseline_frame: dict[str, Any] | None = None,
) -> set[str]:
    return {
        str(change["choice_key"])
        for change in _build_frame_sync_section(backend_frame, remote_frame, baseline_frame)["changes"]
        if change.get("choice_key")
    }


def _changed_scene_sync_keys(
    backend_frame: dict[str, Any],
    remote_frame: dict[str, Any],
    baseline_frame: dict[str, Any] | None = None,
) -> set[str]:
    return {
        str(change["choice_key"])
        for change in _build_scene_sync_section(backend_frame, remote_frame, baseline_frame)["changes"]
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
    baseline_frame = _frame_sync_baseline(frame, backend_frame)
    remote_meta = remote_frame.get("frame_sync") if isinstance(remote_frame.get("frame_sync"), dict) else {}
    frame_section = _build_frame_sync_section(backend_frame, remote_frame, baseline_frame)
    scenes_section = _build_scene_sync_section(backend_frame, remote_frame, baseline_frame)
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
    fetch_frame_http_bytes: FrameFetch,
    *,
    reload_runtime: bool,
) -> None:
    body = json.dumps(
        {
            **payload,
            **({"skip_runtime_reload": True} if not reload_runtime else {}),
        }
    )
    auth_headers = await _frame_admin_session_headers(frame, redis, fetch_frame_http_bytes)
    status, response_body, _headers = await fetch_frame_http_bytes(
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


async def _push_frame_sync_metadata(
    frame: Frame, redis: Redis, fetch_frame_http_bytes: FrameFetch
) -> None:
    await _push_frame_sync_payload(
        frame,
        redis,
        {
            "last_successful_deploy": _frame_sync_snapshot(frame),
            "last_successful_deploy_at": _serialize_datetime(frame.last_successful_deploy_at),
            "frame_sync_mark_deployed": True,
        },
        fetch_frame_http_bytes,
        reload_runtime=False,
    )


async def get_frame_sync_status(
    frame: Frame,
    db: Session,
    redis: Redis,
    fetch_frame_http_bytes: FrameFetch,
) -> dict[str, Any]:
    remote_frame = await _load_live_frame_api_payload(frame, redis, fetch_frame_http_bytes)
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


async def apply_frame_sync(
    frame: Frame,
    data: FrameSyncApplyRequest,
    db: Session,
    redis: Redis,
    fetch_frame_http_bytes: FrameFetch,
) -> dict[str, Any]:
    remote_frame = await _load_live_frame_api_payload(frame, redis, fetch_frame_http_bytes)
    backend_frame = frame.to_dict()
    baseline_frame = _frame_sync_baseline(frame, backend_frame)
    frame_json_choices = _sync_item_choices(
        data.frame_json_choices,
        data.frame_json or "ignore",
        _changed_frame_sync_keys(backend_frame, remote_frame, baseline_frame),
    )
    scenes_json_choices = _sync_item_choices(
        data.scenes_json_choices,
        data.scenes_json or "ignore",
        _changed_scene_sync_keys(backend_frame, remote_frame, baseline_frame),
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
        await _push_frame_sync_payload(
            frame, redis, backend_push_payload, fetch_frame_http_bytes, reload_runtime=True
        )

    remote_after = await _load_live_frame_api_payload(frame, redis, fetch_frame_http_bytes)
    sync_status = _build_frame_sync_status(frame, remote_after)
    if not sync_status["has_changes"]:
        _mark_frame_sync_baseline(frame)
        await update_frame(db, redis, frame)
        db.refresh(frame)
        await _push_frame_sync_metadata(frame, redis, fetch_frame_http_bytes)
        remote_after["last_successful_deploy_at"] = _serialize_datetime(frame.last_successful_deploy_at)
        remote_after["last_successful_deploy"] = frame.last_successful_deploy
        sync_status = _build_frame_sync_status(frame, remote_after)

    return sync_status
