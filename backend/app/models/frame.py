import copy
import json
import os
from datetime import datetime, timezone
from arq import ArqRedis as Redis
from typing import Any, Optional
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import ForeignKey, Integer, String, Double, DateTime, Boolean
from sqlalchemy.orm import Session, mapped_column
from app.database import Base

from app.drivers.devices import device_dimensions
from app.models.apps import get_app_configs
from app.models.settings import get_settings_dict
from app.utils.timezone import frame_timezone, stored_timezone
from app.utils.token import secure_token
from app.utils.tls import generate_frame_tls_material, parse_certificate_not_valid_after
from app.utils.versions import get_versions
from app.websockets import publish_message

DEFAULT_MAX_HTTP_RESPONSE_BYTES = 64 * 1024 * 1024
DEFAULT_TIMEZONE_UPDATE_URL = "https://tz.frameos.net/tzdata.json.gz"
DEFAULT_TIMEZONE_UPDATE_HOUR = 3


def _config_bool(value: Any) -> bool:
    return value is True or str(value).lower() == 'true'


def _optional_config_float(cfg: dict, key: str) -> dict:
    value = cfg.get(key)
    if value in (None, ""):
        return {}
    try:
        return {key: float(value)}
    except (TypeError, ValueError):
        return {}


def _optional_config_int(cfg: dict, key: str) -> dict:
    value = cfg.get(key)
    if value in (None, ""):
        return {}
    try:
        return {key: int(value)}
    except (TypeError, ValueError):
        return {}


def serialize_device_config(cfg: Optional[dict]) -> dict:
    cfg = dict(cfg or {}) if isinstance(cfg, dict) else {}
    return {
        **({"vcom": float(cfg.get('vcom', '0'))} if cfg.get('vcom') not in (None, "") else {}),
        "partial": _config_bool(cfg.get('partial', False)),
        **_optional_config_float(cfg, "partialMaxAreaPercent"),
        **_optional_config_int(cfg, "partialMaxRefreshesBeforeFull"),
        **({"uploadUrl": str(cfg.get('uploadUrl'))} if cfg.get('uploadUrl') else {}),
        **({"uploadHeaders": [
            {"name": str(h.get('name')).strip(), "value": str(h.get('value', ''))}
            for h in cfg.get('uploadHeaders', [])
            if isinstance(h, dict) and str(h.get('name', '')).strip()
        ]} if cfg.get('uploadHeaders') else {}),
    }


def _to_isoformat(value: Optional[datetime]) -> Optional[str]:
    if not value:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat()


def normalize_https_proxy(https_proxy: Optional[dict]) -> dict:
    proxy = dict(https_proxy or {})
    certs = dict(proxy.get('certs') or {})
    try:
        port = int(proxy.get('port') or 8443)
    except (TypeError, ValueError):
        port = 8443
    if port < 1 or port > 65535:
        port = 8443

    return {
        **proxy,
        'port': port,
        'certs': {
            'server': certs.get('server', ''),
            'server_key': certs.get('server_key', ''),
            'client_ca': certs.get('client_ca', ''),
        },
    }


def _serialize_https_proxy(https_proxy: Optional[dict]) -> dict:
    proxy = normalize_https_proxy(https_proxy)

    def _as_iso(value):
        if isinstance(value, datetime):
            return _to_isoformat(value)
        return value

    return {
        'enable': bool(proxy.get('enable', False)),
        'port': proxy.get('port', 8443),
        'expose_only_port': bool(proxy.get('expose_only_port', True)),
        'certs': {
            'server': proxy.get('certs', {}).get('server', ''),
            'server_key': proxy.get('certs', {}).get('server_key', ''),
            'client_ca': proxy.get('certs', {}).get('client_ca', ''),
        },
        'server_cert_not_valid_after': _as_iso(proxy.get('server_cert_not_valid_after')),
        'client_ca_cert_not_valid_after': _as_iso(proxy.get('client_ca_cert_not_valid_after')),
    }


def normalize_frame_admin_auth(frame_admin_auth: Optional[dict]) -> dict:
    auth = dict(frame_admin_auth or {})
    user = auth.get('user') or ''
    password = auth.get('pass') or ''

    if not isinstance(user, str):
        user = ''
    if not isinstance(password, str):
        password = ''

    return {
        'enabled': bool(auth.get('enabled', False)),
        'user': user.strip(),
        'pass': password,
    }


def normalize_reboot_crontab(crontab: Any, default: str = "0 0 * * *") -> str:
    if not isinstance(crontab, str):
        return default

    cron = crontab.strip()
    if not cron:
        return default

    parts = cron.split()
    if len(parts) == 5:
        minute, hour, day_of_month, month, day_of_week = parts
        if hour == "0" and day_of_month == month == day_of_week == "*":
            try:
                legacy_hour = int(minute)
            except ValueError:
                legacy_hour = -1
            if 1 <= legacy_hour <= 23:
                return f"0 {legacy_hour} * * *"

    return cron


def normalize_reboot_config(reboot: Any) -> Any:
    if not isinstance(reboot, dict):
        return reboot
    return {
        **reboot,
        "crontab": normalize_reboot_crontab(reboot.get("crontab", "0 0 * * *")),
    }


def normalize_mountpoints(mountpoints: Any) -> dict:
    config = mountpoints if isinstance(mountpoints, dict) else {}
    raw_items = config.get("items") if isinstance(config.get("items"), list) else []
    items = []

    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        items.append({
            "enabled": bool(raw_item.get("enabled", True)),
            "source": str(raw_item.get("source") or "").strip(),
            "target": str(raw_item.get("target") or "").strip(),
            "username": str(raw_item.get("username") or ""),
            "password": str(raw_item.get("password") or ""),
            "domain": str(raw_item.get("domain") or ""),
            "options": str(raw_item.get("options") or "").strip(),
        })

    return {
        "enabled": bool(config.get("enabled", False)),
        "items": items,
    }


DEFAULT_ERROR_BEHAVIOR = {
    "mode": "show_error_retry",
    "retry_seconds": 60,
    "silent_retry_seconds": 60,
    "silent_retry_forever": False,
    "silent_window_minutes": 10,
    "show_error_retry_seconds": 60,
}

ERROR_BEHAVIOR_MODES = {"safe_mode", "show_error_retry", "silent_retry"}


def _positive_number(value: Any, default: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    return number if number > 0 else default


def normalize_error_behavior(error_behavior: Any) -> dict:
    config = error_behavior if isinstance(error_behavior, dict) else {}
    mode = config.get("mode")
    if mode not in ERROR_BEHAVIOR_MODES:
        mode = DEFAULT_ERROR_BEHAVIOR["mode"]
    silent_window_minutes = config.get("silent_window_minutes", config.get("silent_retry_minutes"))

    return {
        "mode": mode,
        "retry_seconds": _positive_number(config.get("retry_seconds"), DEFAULT_ERROR_BEHAVIOR["retry_seconds"]),
        "silent_retry_seconds": _positive_number(
            config.get("silent_retry_seconds"),
            DEFAULT_ERROR_BEHAVIOR["silent_retry_seconds"],
        ),
        "silent_retry_forever": bool(config.get("silent_retry_forever", DEFAULT_ERROR_BEHAVIOR["silent_retry_forever"])),
        "silent_window_minutes": _positive_number(
            silent_window_minutes,
            DEFAULT_ERROR_BEHAVIOR["silent_window_minutes"],
        ),
        "show_error_retry_seconds": _positive_number(
            config.get("show_error_retry_seconds"),
            DEFAULT_ERROR_BEHAVIOR["show_error_retry_seconds"],
        ),
    }


def normalize_timezone_update_hour(value: Any) -> int:
    try:
        hour = int(value if value is not None else DEFAULT_TIMEZONE_UPDATE_HOUR)
    except (TypeError, ValueError):
        return DEFAULT_TIMEZONE_UPDATE_HOUR
    return hour if 0 <= hour <= 23 else DEFAULT_TIMEZONE_UPDATE_HOUR


def normalize_timezone_update_url(value: Any) -> str:
    url = str(value or DEFAULT_TIMEZONE_UPDATE_URL).strip()
    return url or DEFAULT_TIMEZONE_UPDATE_URL


def resolve_timezone_updater(timezone_updater: Any) -> dict:
    config = timezone_updater if isinstance(timezone_updater, dict) else {}

    return {
        "enabled": bool(config.get("enabled", True)),
        "hour": normalize_timezone_update_hour(config.get("hour")),
        "url": normalize_timezone_update_url(config.get("url")),
    }


def compact_timezone_updater(timezone_updater: Any, include_enabled_default: bool = False) -> dict | None:
    if not isinstance(timezone_updater, dict):
        return {"enabled": True} if include_enabled_default else None

    resolved = resolve_timezone_updater(timezone_updater)
    compact: dict[str, Any] = {}

    if include_enabled_default or resolved["enabled"] is not True:
        compact["enabled"] = resolved["enabled"]
    if "hour" in timezone_updater and resolved["hour"] != DEFAULT_TIMEZONE_UPDATE_HOUR:
        compact["hour"] = resolved["hour"]
    if "url" in timezone_updater and resolved["url"] != DEFAULT_TIMEZONE_UPDATE_URL:
        compact["url"] = resolved["url"]

    return compact or None


# NB! Update frontend/src/types.tsx if you change this
class Frame(Base):
    __tablename__ = 'frame'
    id = mapped_column(Integer, primary_key=True)
    project_id = mapped_column(Integer, ForeignKey("project.id"), nullable=False, index=True)
    name = mapped_column(String(256), nullable=False)
    mode = mapped_column(String(32), nullable=True) # rpios, buildroot, embedded
    # sending commands to frame
    frame_host = mapped_column(String(256), nullable=False)
    frame_port = mapped_column(Integer, default=8787)
    frame_access_key = mapped_column(String(256), nullable=True)
    frame_access = mapped_column(String(50), nullable=True)
    frame_admin_auth = mapped_column(JSON, nullable=True)
    https_proxy = mapped_column(JSON, nullable=True)
    ssh_user = mapped_column(String(50), nullable=True)
    ssh_pass = mapped_column(String(50), nullable=True)
    ssh_port = mapped_column(Integer, default=22)
    ssh_keys = mapped_column(JSON, nullable=True)
    # receiving logs, connection from frame to us
    server_host = mapped_column(String(256), nullable=True)
    server_port = mapped_column(Integer, default=8989)
    server_api_key = mapped_column(String(64), nullable=True, unique=True)
    server_send_logs = mapped_column(Boolean, default=True)
    # frame metadata
    status = mapped_column(String(15), nullable=False)
    archived = mapped_column(Boolean, nullable=False, default=False)
    version = mapped_column(String(50), nullable=True)
    width = mapped_column(Integer, nullable=True)
    height = mapped_column(Integer, nullable=True)
    device = mapped_column(String(256), nullable=True)
    device_config = mapped_column(JSON, nullable=True)
    color = mapped_column(String(256), nullable=True)
    timezone = mapped_column(String(128), nullable=True)
    timezone_updater = mapped_column(JSON, nullable=True)
    interval = mapped_column(Double, default=300)
    metrics_interval = mapped_column(Double, default=60)
    max_http_response_bytes = mapped_column(Integer, default=DEFAULT_MAX_HTTP_RESPONSE_BYTES)
    scaling_mode = mapped_column(String(64), nullable=True)  # contain (default), cover, stretch, center
    image_engine = mapped_column(String(32), nullable=True)  # empty and pixie use Pixie; imagemagick uses ImageMagick
    rotate = mapped_column(Integer, nullable=True)
    flip = mapped_column(String(32), nullable=True)
    log_to_file = mapped_column(String(256), nullable=True)
    assets_path = mapped_column(String(256), nullable=True)
    save_assets = mapped_column(JSON, nullable=True)
    debug = mapped_column(Boolean, nullable=True)
    upload_fonts = mapped_column(String(10), nullable=True)
    last_log_at = mapped_column(DateTime, nullable=True)
    reboot = mapped_column(JSON, nullable=True)
    control_code = mapped_column(JSON, nullable=True)
    scenes = mapped_column(JSON, nullable=True, default=list)
    last_successful_deploy = mapped_column(JSON, nullable=True) # contains frame.to_dict() of last successful deploy
    last_successful_deploy_at = mapped_column(DateTime, nullable=True)
    schedule = mapped_column(JSON, nullable=True)
    gpio_buttons = mapped_column(JSON, nullable=True)
    network = mapped_column(JSON, nullable=True)
    agent = mapped_column(JSON, nullable=True)
    mountpoints = mapped_column(JSON, nullable=True)
    error_behavior = mapped_column(JSON, nullable=True)
    palette = mapped_column(JSON, nullable=True)
    buildroot = mapped_column(JSON, nullable=True)
    embedded = mapped_column(JSON, nullable=True)
    rpios = mapped_column(JSON, nullable=True)
    terminal_history = mapped_column(JSON, nullable=True, default=list)

    # not used
    apps = mapped_column(JSON, nullable=True)
    image_url = mapped_column(String(256), nullable=True)
    background_color = mapped_column(String(64), nullable=True) # still used as fallback in frontend

    def to_dict(self):
        return {
            'id': self.id,
            'project_id': self.project_id,
            'name': self.name,
            'mode': self.mode,
            'frame_host': self.frame_host,
            'frame_port': self.frame_port,
            'frame_access_key': self.frame_access_key,
            'frame_access': self.frame_access,
            'frame_admin_auth': normalize_frame_admin_auth(self.frame_admin_auth),
            'https_proxy': _serialize_https_proxy(self.https_proxy),
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'ssh_port': self.ssh_port,
            'ssh_keys': self.ssh_keys,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'server_send_logs': self.server_send_logs,
            'status': self.status,
            'archived': self.archived,
            'version': self.version,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'device_config': self.device_config,
            'color': self.color,
            'timezone': self.timezone,
            'timezone_updater': compact_timezone_updater(self.timezone_updater, include_enabled_default=True),
            'interval': self.interval,
            'metrics_interval': self.metrics_interval,
            'max_http_response_bytes': self.max_http_response_bytes or DEFAULT_MAX_HTTP_RESPONSE_BYTES,
            'scaling_mode': self.scaling_mode,
            'image_engine': self.image_engine,
            'rotate': self.rotate,
            'flip': self.flip,
            'background_color': self.background_color,
            'debug': self.debug,
            'scenes': self.scenes,
            'last_log_at': self.last_log_at.replace(tzinfo=timezone.utc).isoformat() if self.last_log_at else None,
            'log_to_file': self.log_to_file,
            'assets_path': self.assets_path,
            'save_assets': self.save_assets,
            'upload_fonts': self.upload_fonts,
            'reboot': normalize_reboot_config(self.reboot),
            'control_code': self.control_code,
            'schedule': self.schedule,
            'gpio_buttons': self.gpio_buttons,
            'network': self.network,
            'agent': self.agent,
            'mountpoints': normalize_mountpoints(self.mountpoints),
            'error_behavior': normalize_error_behavior(self.error_behavior),
            'palette': self.palette,
            'buildroot': self.buildroot,
            'embedded': self.embedded,
            'rpios': self.rpios,
            'terminal_history': self.terminal_history,
            'last_successful_deploy': self.last_successful_deploy,
            'last_successful_deploy_at': self.last_successful_deploy_at.replace(tzinfo=timezone.utc).isoformat() if self.last_successful_deploy_at else None,
        }

async def new_frame(
    db: Session,
    redis: Redis,
    name: str,
    frame_host: str,
    server_host: str,
    device: Optional[str] = None,
    interval: Optional[float] = None,
    project_id: Optional[int] = None,
) -> Frame:
    if '@' in frame_host:
        user_pass, frame_host = frame_host.split('@')
    else:
        user_pass, frame_host = 'pi', frame_host

    if ':' in frame_host:
        frame_host, ssh_port_initial = frame_host.split(':')
        ssh_port = int(ssh_port_initial or '22')
        if ssh_port > 65535 or ssh_port < 0:
            raise ValueError("Invalid frame port")
    else:
        ssh_port = 22

    if ':' in user_pass:
        user, password = user_pass.split(':')
    else:
        user, password = user_pass, None

    if ':' in server_host:
        server_host, server_port_initial = server_host.split(':')
        server_port = int(server_port_initial or '8989')
    else:
        server_port = 8989

    tls_material = generate_frame_tls_material(frame_host)
    dimensions = device_dimensions(device)
    if project_id is None:
        from app.tenancy import ensure_default_project

        project_id = ensure_default_project(db).id

    frame = Frame(
        project_id=project_id,
        name=name,
        mode="rpios",
        ssh_user=user,
        ssh_pass=password,
        ssh_port=ssh_port,
        frame_host=frame_host,
        frame_access_key=secure_token(20),
        frame_access="private",
        https_proxy={
            "enable": True,
            "port": 8443,
            "expose_only_port": True,
            "certs": {
                "server": tls_material["server"],
                "server_key": tls_material["server_key"],
                "client_ca": tls_material["client_ca"],
            },
            "server_cert_not_valid_after": _to_isoformat(parse_certificate_not_valid_after(tls_material["server"])),
            "client_ca_cert_not_valid_after": _to_isoformat(parse_certificate_not_valid_after(tls_material["client_ca"])),
        },
        server_host=server_host,
        server_port=int(server_port),
        server_api_key=secure_token(32),
        server_send_logs=True,
        width=dimensions[0] if dimensions else None,
        height=dimensions[1] if dimensions else None,
        interval=interval or 300,
        max_http_response_bytes=DEFAULT_MAX_HTTP_RESPONSE_BYTES,
        status="uninitialized",
        scenes=[],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        device=device or "web_only",
        timezone=None,
        timezone_updater=None,
        log_to_file=None, # spare the SD card from load
        assets_path='/srv/assets',
        save_assets=True,
        upload_fonts='', # all
        network={
            "networkCheck": True,
            "networkCheckTimeoutSeconds": 30,
            "networkCheckUrl": "https://networkcheck.frameos.net/",
            "wifiHotspot": "disabled",
            "wifiHotspotSsid": "FrameOS-Setup",
            "wifiHotspotPassword": "frame1234",
            "wifiHotspotTimeoutSeconds": 300,
        },
        agent={
            "agentEnabled": False,
            "agentRunCommands": False,
            "agentSharedSecret": secure_token(32)
        },
        mountpoints={"enabled": False, "items": []},
        error_behavior=DEFAULT_ERROR_BEHAVIOR.copy(),
        control_code={"enabled": "false", "position": "top-right"},
        schedule={"events": []},
        reboot={"enabled": "true", "crontab": "0 4 * * *"}
    )
    db.add(frame)
    db.commit()
    await publish_message(redis, "new_frame", frame.to_dict())

    from app.models import new_log
    await new_log(db, redis, int(frame.id), "welcome", f"The frame \"{frame.name}\" has been created!")

    return frame




def refresh_tls_certificate_validity_dates(frame: Frame):
    https_proxy = normalize_https_proxy(frame.https_proxy)
    certs = https_proxy.get('certs', {})
    https_proxy['server_cert_not_valid_after'] = _to_isoformat(parse_certificate_not_valid_after(certs.get('server', '')))
    https_proxy['client_ca_cert_not_valid_after'] = _to_isoformat(parse_certificate_not_valid_after(certs.get('client_ca', '')))
    frame.https_proxy = https_proxy


async def update_frame(db: Session, redis: Redis, frame: Frame):
    db.add(frame)
    db.commit()
    db.refresh(frame)
    await publish_message(redis, "update_frame", frame.to_dict())


async def delete_frame(db: Session, redis: Redis, frame_id: int, project_id: int):
    if frame := db.query(Frame).filter_by(id=frame_id, project_id=project_id).first():
        # delete corresonding log and metric entries first
        from .log import Log
        db.query(Log).filter_by(project_id=project_id, frame_id=frame_id).delete()
        from .metrics import Metrics
        db.query(Metrics).filter_by(project_id=project_id, frame_id=frame_id).delete()
        from .scene_image import SceneImage
        db.query(SceneImage).filter_by(project_id=project_id, frame_id=frame_id).delete()

        cache_key = f'frame:{frame_id}:image'
        await redis.delete(cache_key)

        db.delete(frame)
        db.commit()
        await publish_message(redis, "delete_frame", {"id": frame_id, "project_id": project_id})
        return True
    return False


def get_templates_json() -> dict:
    templates_schema_path = os.path.join("..", "frontend", "schema", "templates.json")
    if os.path.exists(templates_schema_path):
        with open(templates_schema_path, 'r') as file:
            return json.load(file)
    else:
        return {}


def frame_image_engine(frame: Frame) -> str:
    image_engine = frame.image_engine or ""
    if (frame.mode or "rpios") == "buildroot" and image_engine == "imagemagick":
        return ""
    return image_engine


def get_frame_json(db: Session, frame: Frame) -> dict:
    https_proxy = normalize_https_proxy(frame.https_proxy)
    network = frame.network or {}
    agent = frame.agent or {}
    mountpoints = normalize_mountpoints(frame.mountpoints)
    error_behavior = normalize_error_behavior(frame.error_behavior)
    frameos_version = get_versions().get("frameos")
    all_settings = get_settings_dict(db, project_id=frame.project_id)
    defaults = all_settings.get("defaults") or {}
    default_timezone = defaults.get("timezone")
    explicit_timezone = stored_timezone(frame.timezone)
    timezone_updater = resolve_timezone_updater(frame.timezone_updater)
    fallback_dimensions = device_dimensions(frame.device)
    frame_json: dict = {
        **({"frameosVersion": frameos_version} if isinstance(frameos_version, str) and frameos_version else {}),
        "name": frame.name,
        "mode": frame.mode or 'rpios',
        "frameHost": frame.frame_host or "localhost",
        "framePort": frame.frame_port or 8787,
        "frameAccessKey": frame.frame_access_key,
        "frameAccess": frame.frame_access,
        "httpsProxy": {
            "enable": bool(https_proxy.get("enable", False)),
            "port": https_proxy.get("port", 8443),
            "exposeOnlyPort": bool(https_proxy.get("expose_only_port", True)),
            "serverCert": https_proxy.get("certs", {}).get("server", ""),
            "serverKey": https_proxy.get("certs", {}).get("server_key", ""),
        },
        "serverHost": frame.server_host or "localhost",
        "serverPort": frame.server_port or 8989,
        "serverApiKey": frame.server_api_key,
        "serverSendLogs": bool(frame.server_send_logs if frame.server_send_logs is not None else True),
        "width": frame.width or (fallback_dimensions[0] if fallback_dimensions else 0),
        "height": frame.height or (fallback_dimensions[1] if fallback_dimensions else 0),
        "device": frame.device or "web_only",
        "deviceConfig": serialize_device_config(frame.device_config),
        "interval": frame.interval or 300.0,
        "metricsInterval": frame.metrics_interval or 60.0,
        "maxHttpResponseBytes": frame.max_http_response_bytes or DEFAULT_MAX_HTTP_RESPONSE_BYTES,
        "debug": frame.debug or False,
        "scalingMode": frame.scaling_mode or "contain",
        "imageEngine": frame_image_engine(frame),
        "rotate": frame.rotate or 0,
        "flip": frame.flip,
        "logToFile": frame.log_to_file,
        "assetsPath": frame.assets_path,
        "saveAssets": frame.save_assets,
        "schedule": frame.schedule,
        "gpioButtons": [
            {
                "pin": int(button.get("pin", 0)),
                "label": str(button.get("label", "Pin " + str(button.get("pin"))))
            }
            for button in (frame.gpio_buttons or [])
            if int(button.get("pin", 0)) > 0
        ],
        "palette": frame.palette or {},
        # "nix": frame.nix or {}, # We don't need this in the json. It's only used for building the system.
        "controlCode": {
            "enabled": frame.control_code.get('enabled', 'false') == 'true',
            "position": frame.control_code.get('position', 'top-right'),
            "size": float(frame.control_code.get('size', '2')),
            "padding": int(frame.control_code.get('padding', '1')),
            "offsetX": int(frame.control_code.get('offsetX', '0')),
            "offsetY": int(frame.control_code.get('offsetY', '0')),
            "qrCodeColor": frame.control_code.get('qrCodeColor', '#000000'),
            "backgroundColor": frame.control_code.get('backgroundColor', '#ffffff'),
        } if frame.control_code else {"enabled": False},
        "network": {
            "networkCheck": network.get('networkCheck', True),
            "networkCheckTimeoutSeconds": int(network.get('networkCheckTimeoutSeconds', 30)),
            "networkCheckUrl": network.get('networkCheckUrl', "https://networkcheck.frameos.net/"),
            "wifiHotspot": network.get('wifiHotspot', "disabled"),
            "wifiHotspotSsid": network.get('wifiHotspotSsid', "FrameOS-Setup"),
            "wifiHotspotPassword": network.get('wifiHotspotPassword', "frame1234"),
            "wifiHotspotTimeoutSeconds": int(network.get('wifiHotspotTimeoutSeconds', 300)),
        },
        "agent": {
            "agentEnabled": bool(agent.get('agentEnabled', False)),
            "agentRunCommands": bool(agent.get('agentRunCommands', False)),
            "agentSharedSecret": agent.get('agentSharedSecret', secure_token(32)),
        },
        "mountpoints": mountpoints,
        "errorBehavior": {
            "mode": error_behavior["mode"],
            "retrySeconds": error_behavior["retry_seconds"],
            "silentRetrySeconds": error_behavior["silent_retry_seconds"],
            "silentRetryForever": error_behavior["silent_retry_forever"],
            "silentWindowMinutes": error_behavior["silent_window_minutes"],
            "showErrorRetrySeconds": error_behavior["show_error_retry_seconds"],
        },
        "timeZoneUpdates": {
            "enabled": timezone_updater["enabled"],
            "hour": timezone_updater["hour"],
            "url": timezone_updater["url"],
        },
    }
    if explicit_timezone:
        frame_json["timeZone"] = explicit_timezone
    elif (frame.mode or "rpios") == "buildroot":
        frame_json["timeZone"] = frame_timezone(frame.timezone, default_timezone)

    schedule = frame.schedule
    if schedule is not None:
        schedule = copy.deepcopy(schedule)
        if schedule.get('disabled', None):
            schedule = None
        else:
            events = []
            for event in schedule.get('events', []):
                if event.get('disabled', None):
                    continue
                events.append(event)
            schedule['events'] = events
    frame_json["schedule"] = schedule

    setting_keys = set()
    app_configs = get_app_configs()
    for scene in list(frame.scenes):
        for node in scene.get('nodes', []):
            if node.get('type', None) == 'app':
                sources = node.get('data', {}).get('sources', None)
                keyword = node.get('data', {}).get('keyword', None)
                scene_app = scene.get('apps', {}).get(keyword) if isinstance(scene.get('apps', {}), dict) else None
                if not sources and isinstance(scene_app, dict):
                    sources = scene_app.get('sources', None)
                if sources and len(sources) > 0:
                    try:
                        config = sources.get('config.json', '{}')
                        config = json.loads(config)
                        settings = config.get('settings', [])
                        for key in settings:
                            setting_keys.add(key)
                    except:  # noqa: E722
                        pass
                else:
                    if keyword:
                        app_config = app_configs.get(keyword, None)
                        if app_config:
                            settings = app_config.get('settings', [])
                            for key in settings:
                                setting_keys.add(key)

    final_settings = {}
    for key in setting_keys:
        final_settings[key] = all_settings.get(key, None)

    frame_admin_auth = normalize_frame_admin_auth(frame.frame_admin_auth)

    frame_json['frameAdminAuth'] = {
        'enabled': frame_admin_auth['enabled'],
        **({'user': frame_admin_auth['user']} if frame_admin_auth['user'] else {}),
        **({'pass': frame_admin_auth['pass']} if frame_admin_auth['pass'] else {}),
    }

    frame_sync_deploy_revision = getattr(frame, "_frame_sync_deploy_revision", None)
    if isinstance(frame_sync_deploy_revision, str) and frame_sync_deploy_revision:
        frame_json["frameApi"] = {
            "frame_sync_current_revision": frame_sync_deploy_revision,
            "frame_sync_deployed_revision": frame_sync_deploy_revision,
        }

    frame_json['settings'] = final_settings
    return frame_json

def get_interpreted_scenes_json(frame: Frame) -> list[dict]:
    interpreted_scenes = []
    for scene in frame.scenes:
        execution = scene.get("settings", {}).get("execution", "compiled")
        if execution == "interpreted":
            interpreted_scenes.append(scene)
    return interpreted_scenes
