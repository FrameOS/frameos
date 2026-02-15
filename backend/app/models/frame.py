import json
import copy
import os
from datetime import timezone
from arq import ArqRedis as Redis
from typing import Optional
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy import Integer, String, Double, DateTime, Boolean
from sqlalchemy.orm import Session, mapped_column
from app.database import Base

from app.models.apps import get_app_configs
from app.models.settings import get_settings_dict
from app.utils.token import secure_token
from app.utils.tls import generate_frame_tls_material, parse_certificate_not_valid_after
from app.websockets import publish_message


# NB! Update frontend/src/types.tsx if you change this
class Frame(Base):
    __tablename__ = 'frame'
    id = mapped_column(Integer, primary_key=True)
    name = mapped_column(String(256), nullable=False)
    mode = mapped_column(String(32), nullable=True) # rpios, nixos, buildroot
    # sending commands to frame
    frame_host = mapped_column(String(256), nullable=False)
    frame_port = mapped_column(Integer, default=8787)
    frame_access_key = mapped_column(String(256), nullable=True)
    frame_access = mapped_column(String(50), nullable=True)
    enable_tls = mapped_column(Boolean, nullable=True)
    tls_port = mapped_column(Integer, default=8443)
    expose_only_tls_port = mapped_column(Boolean, nullable=True)
    tls_server_cert = mapped_column(String, nullable=True)
    tls_server_key = mapped_column(String, nullable=True)
    tls_client_ca_cert = mapped_column(String, nullable=True)
    tls_server_cert_not_valid_after = mapped_column(DateTime, nullable=True)
    tls_client_ca_cert_not_valid_after = mapped_column(DateTime, nullable=True)
    ssh_user = mapped_column(String(50), nullable=True)
    ssh_pass = mapped_column(String(50), nullable=True)
    ssh_port = mapped_column(Integer, default=22)
    ssh_keys = mapped_column(JSON, nullable=True)
    # receiving logs, connection from frame to us
    server_host = mapped_column(String(256), nullable=True)
    server_port = mapped_column(Integer, default=8989)
    server_api_key = mapped_column(String(64), nullable=True)
    # frame metadata
    status = mapped_column(String(15), nullable=False)
    version = mapped_column(String(50), nullable=True)
    width = mapped_column(Integer, nullable=True)
    height = mapped_column(Integer, nullable=True)
    device = mapped_column(String(256), nullable=True)
    device_config = mapped_column(JSON, nullable=True)
    color = mapped_column(String(256), nullable=True)
    interval = mapped_column(Double, default=300)
    metrics_interval = mapped_column(Double, default=60)
    scaling_mode = mapped_column(String(64), nullable=True)  # contain (default), cover, stretch, center
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
    palette = mapped_column(JSON, nullable=True)
    nix = mapped_column(JSON, nullable=True)
    buildroot = mapped_column(JSON, nullable=True)
    rpios = mapped_column(JSON, nullable=True)
    terminal_history = mapped_column(JSON, nullable=True, default=list)

    # not used
    apps = mapped_column(JSON, nullable=True)
    image_url = mapped_column(String(256), nullable=True)
    background_color = mapped_column(String(64), nullable=True) # still used as fallback in frontend

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'mode': self.mode,
            'frame_host': self.frame_host,
            'frame_port': self.frame_port,
            'frame_access_key': self.frame_access_key,
            'frame_access': self.frame_access,
            'enable_tls': self.enable_tls,
            'tls_port': self.tls_port,
            'expose_only_tls_port': self.expose_only_tls_port,
            'tls_server_cert': self.tls_server_cert,
            'tls_server_key': self.tls_server_key,
            'tls_client_ca_cert': self.tls_client_ca_cert,
            'tls_server_cert_not_valid_after': self.tls_server_cert_not_valid_after.replace(tzinfo=timezone.utc).isoformat() if self.tls_server_cert_not_valid_after else None,
            'tls_client_ca_cert_not_valid_after': self.tls_client_ca_cert_not_valid_after.replace(tzinfo=timezone.utc).isoformat() if self.tls_client_ca_cert_not_valid_after else None,
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'ssh_port': self.ssh_port,
            'ssh_keys': self.ssh_keys,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'status': self.status,
            'version': self.version,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'device_config': self.device_config,
            'color': self.color,
            'interval': self.interval,
            'metrics_interval': self.metrics_interval,
            'scaling_mode': self.scaling_mode,
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
            'reboot': self.reboot,
            'control_code': self.control_code,
            'schedule': self.schedule,
            'gpio_buttons': self.gpio_buttons,
            'network': self.network,
            'agent': self.agent,
            'palette': self.palette,
            'nix': self.nix,
            'buildroot': self.buildroot,
            'rpios': self.rpios,
            'terminal_history': self.terminal_history,
            'last_successful_deploy': self.last_successful_deploy,
            'last_successful_deploy_at': self.last_successful_deploy_at.replace(tzinfo=timezone.utc).isoformat() if self.last_successful_deploy_at else None,
        }

async def new_frame(db: Session, redis: Redis, name: str, frame_host: str, server_host: str, device: Optional[str] = None, interval: Optional[float] = None) -> Frame:
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

    frame = Frame(
        name=name,
        mode="rpios",
        ssh_user=user,
        ssh_pass=password,
        ssh_port=ssh_port,
        frame_host=frame_host,
        frame_access_key=secure_token(20),
        frame_access="private",
        enable_tls=True,
        tls_port=8443,
        expose_only_tls_port=True,
        tls_server_cert=tls_material["tls_server_cert"],
        tls_server_key=tls_material["tls_server_key"],
        tls_client_ca_cert=tls_material["tls_client_ca_cert"],
        tls_server_cert_not_valid_after=parse_certificate_not_valid_after(tls_material["tls_server_cert"]),
        tls_client_ca_cert_not_valid_after=parse_certificate_not_valid_after(tls_material["tls_client_ca_cert"]),
        server_host=server_host,
        server_port=int(server_port),
        server_api_key=secure_token(32),
        interval=interval or 300,
        status="uninitialized",
        scenes=[],
        apps=[],
        scaling_mode="contain",
        rotate=0,
        device=device or "web_only",
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
        control_code={"enabled": "false", "position": "top-right"},
        schedule={"events": []},
        reboot={"enabled": "true", "crontab": "4 0 * * *"},
        nix={}
    )
    db.add(frame)
    db.commit()
    await publish_message(redis, "new_frame", frame.to_dict())

    from app.models import new_log
    await new_log(db, redis, int(frame.id), "welcome", f"The frame \"{frame.name}\" has been created!")

    return frame




def refresh_tls_certificate_validity_dates(frame: Frame):
    frame.tls_server_cert_not_valid_after = parse_certificate_not_valid_after(frame.tls_server_cert)
    frame.tls_client_ca_cert_not_valid_after = parse_certificate_not_valid_after(frame.tls_client_ca_cert)


async def update_frame(db: Session, redis: Redis, frame: Frame):
    db.add(frame)
    db.commit()
    await publish_message(redis, "update_frame", frame.to_dict())


async def delete_frame(db: Session, redis: Redis, frame_id: int):
    if frame := db.get(Frame, frame_id):
        # delete corresonding log and metric entries first
        from .log import Log
        db.query(Log).filter_by(frame_id=frame_id).delete()
        from .metrics import Metrics
        db.query(Metrics).filter_by(frame_id=frame_id).delete()
        from .scene_image import SceneImage
        db.query(SceneImage).filter_by(frame_id=frame_id).delete()

        cache_key = f'frame:{frame.frame_host}:{frame.frame_port}:image'
        await redis.delete(cache_key)

        db.delete(frame)
        db.commit()
        await publish_message(redis, "delete_frame", {"id": frame_id})
        return True
    return False


def get_templates_json() -> dict:
    templates_schema_path = os.path.join("..", "frontend", "schema", "templates.json")
    if os.path.exists(templates_schema_path):
        with open(templates_schema_path, 'r') as file:
            return json.load(file)
    else:
        return {}

def get_frame_json(db: Session, frame: Frame) -> dict:
    network = frame.network or {}
    agent = frame.agent or {}
    frame_json: dict = {
        "name": frame.name,
        "mode": frame.mode or 'rpios',
        "frameHost": frame.frame_host or "localhost",
        "framePort": frame.frame_port or 8787,
        "frameAccessKey": frame.frame_access_key,
        "frameAccess": frame.frame_access,
        "enableTls": bool(frame.enable_tls),
        "tlsPort": frame.tls_port or 8443,
        "exposeOnlyTlsPort": bool(frame.expose_only_tls_port),
        "tlsServerCert": frame.tls_server_cert or "",
        "tlsServerKey": frame.tls_server_key or "",
        "serverHost": frame.server_host or "localhost",
        "serverPort": frame.server_port or 8989,
        "serverApiKey": frame.server_api_key,
        "width": frame.width or 0,
        "height": frame.height or 0,
        "device": frame.device or "web_only",
        "deviceConfig": (lambda cfg: {
            **({"vcom": float(cfg.get('vcom', '0'))} if cfg.get('vcom') not in (None, "") else {}),
            **({"uploadUrl": str(cfg.get('uploadUrl'))} if cfg.get('uploadUrl') else {}),
            **({"uploadHeaders": [
                {"name": str(h.get('name')).strip(), "value": str(h.get('value', ''))}
                for h in cfg.get('uploadHeaders', [])
                if isinstance(h, dict) and str(h.get('name', '')).strip()
            ]} if cfg.get('uploadHeaders') else {}),
        })(frame.device_config or {}),
        "metricsInterval": frame.metrics_interval or 60.0,
        "debug": frame.debug or False,
        "scalingMode": frame.scaling_mode or "contain",
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
        }
    }

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
                    keyword = node.get('data', {}).get('keyword', None)
                    if keyword:
                        app_config = app_configs.get(keyword, None)
                        if app_config:
                            settings = app_config.get('settings', [])
                            for key in settings:
                                setting_keys.add(key)

    all_settings = get_settings_dict(db)
    final_settings = {}
    for key in setting_keys:
        final_settings[key] = all_settings.get(key, None)

    frame_json['settings'] = final_settings
    return frame_json

def get_interpreted_scenes_json(frame: Frame) -> list[dict]:
    interpreted_scenes = []
    for scene in frame.scenes:
        execution = scene.get("settings", {}).get("execution", "compiled")
        if execution == "interpreted":
            interpreted_scenes.append(scene)
    return interpreted_scenes
