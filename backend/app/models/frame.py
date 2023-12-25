import json
import os
import uuid
import secrets
from app import db, socketio
from typing import Dict, Optional
from sqlalchemy.dialects.sqlite import JSON

from app.models.apps import get_app_configs, get_local_frame_apps
from app.models.settings import get_settings_dict


# NB! Update frontend/src/types.tsx if you change this
class Frame(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(256), nullable=False)
    # sending commands to frame
    frame_host = db.Column(db.String(256), nullable=False)
    frame_port = db.Column(db.Integer, default=8787)
    ssh_user = db.Column(db.String(50), nullable=True)
    ssh_pass = db.Column(db.String(50), nullable=True)
    ssh_port = db.Column(db.Integer, default=22)
    # receiving logs, connection from frame to us
    server_host = db.Column(db.String(256), nullable=True)
    server_port = db.Column(db.Integer, default=8989)
    server_api_key = db.Column(db.String(64), nullable=True)
    # frame metadata
    status = db.Column(db.String(15), nullable=False)
    version = db.Column(db.String(50), nullable=True)
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)
    device = db.Column(db.String(256), nullable=True)
    color = db.Column(db.String(256), nullable=True)
    interval = db.Column(db.Double, default=300)
    metrics_interval = db.Column(db.Double, default=60)
    scaling_mode = db.Column(db.String(64), nullable=True)  # cover (default), contain, stretch, center
    background_color = db.Column(db.String(64), nullable=True)
    rotate = db.Column(db.Integer, nullable=True)
    # apps
    apps = db.Column(JSON, nullable=True)
    scenes = db.Column(JSON, nullable=True)

    # deprecated
    image_url = db.Column(db.String(256), nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'frame_host': self.frame_host,
            'frame_port': self.frame_port,
            'ssh_user': self.ssh_user,
            'ssh_pass': self.ssh_pass,
            'ssh_port': self.ssh_port,
            'server_host': self.server_host,
            'server_port': self.server_port,
            'server_api_key': self.server_api_key,
            'status': self.status,
            'version': self.version,
            'width': self.width,
            'height': self.height,
            'device': self.device,
            'color': self.color,
            'interval': self.interval,
            'metrics_interval': self.metrics_interval,
            'scaling_mode': self.scaling_mode,
            'rotate': self.rotate,
            'background_color': self.background_color,
            'scenes': self.scenes,
        }


def new_frame(name: str, frame_host: str, server_host: str, device: Optional[str] = None) -> Frame:
    if '@' in frame_host:
        user_pass, frame_host = frame_host.split('@')
    else:
        user_pass, frame_host = 'pi', frame_host

    if ':' in frame_host:
        frame_host, ssh_port = frame_host.split(':')
        ssh_port = int(ssh_port or '22')
        if int(ssh_port) > 65535 or int(ssh_port) < 0:
            raise ValueError("Invalid frame port")
    else:
        ssh_port = 22

    if ':' in user_pass:
        user, password = user_pass.split(':')
    else:
        user, password = user_pass, None

    if ':' in server_host:
        server_host, server_port = server_host.split(':')
    else:
        server_port = 8989

    frame = Frame(
        name=name,
        ssh_user=user,
        ssh_pass=password,
        frame_host=frame_host,
        ssh_port=ssh_port,
        server_host=server_host,
        server_port=int(server_port),
        server_api_key=secrets.token_hex(32),
        status="uninitialized",
        apps=[],
        scenes=[create_default_scene()],
        scaling_mode="cover",
        rotate=0,
        background_color="white",
        device=device or "web_only",
    )
    db.session.add(frame)
    db.session.commit()
    socketio.emit('new_frame', frame.to_dict())
    return frame


def update_frame(frame: Frame):
    db.session.add(frame)
    db.session.commit()
    socketio.emit('update_frame', frame.to_dict())


def delete_frame(frame_id: int):
    frame = Frame.query.get(frame_id)
    if frame:
        from .log import Log
        Log.query.filter_by(frame_id=frame_id).delete()
        db.session.delete(frame)
        db.session.commit()
        socketio.emit('delete_frame', {'id': frame_id})
        return True
    return False


def create_default_scene() -> Dict:
    event_uuid = str(uuid.uuid4())
    unsplash_uuid = str(uuid.uuid4())
    edge_uuid = str(uuid.uuid4())
    return {
        "id": "default",
        "edges": [
            {
                "id": edge_uuid,
                "source": event_uuid,
                "sourceHandle": "next",
                "target": unsplash_uuid,
                "targetHandle": "prev"
            }
        ],
        "nodes": [
            {
                "id": event_uuid,
                "type": "event",
                "position": {
                    "x": 259.18108974358967,
                    "y": 379.3192307692308
                },
                "data": {
                    "keyword": "render"
                },
                "width": 132,
                "height": 72
            },
            {
                "id": unsplash_uuid,
                "type": "app",
                "position": {
                    "x": 598.6810897435896,
                    "y": 412.8192307692308
                },
                "data": {
                    "keyword": "unsplash",
                    "config": {}
                },
                "width": 133,
                "height": 102
            }
        ]
    }


def get_frame_json(frame: Frame) -> dict:
    # TODO: switch to an allowlist instead
    frame_json = frame.to_dict()
    frame_json.pop("frame_host", None)
    frame_json.pop("ssh_user", None)
    frame_json.pop("ssh_pass", None)
    frame_json.pop("ssh_port", None)
    frame_json.pop("status", None)
    frame_json.pop("id", None)
    frame_json.pop("name", None)
    frame_json.pop("scenes", None)
    frame_json.pop("version", None)

    setting_keys = set()
    app_configs = get_app_configs()
    for scene in frame.scenes:
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
                    except:
                        pass
                else:
                    keyword = node.get('data', {}).get('keyword', None)
                    if keyword:
                        app_config = app_configs.get(keyword, None)
                        if app_config:
                            settings = app_config.get('settings', [])
                            for key in settings:
                                setting_keys.add(key)

    all_settings = get_settings_dict()
    final_settings = {}
    for key in setting_keys:
        final_settings[key] = all_settings.get(key, None)

    frame_dsn = all_settings.get('sentry', {}).get('frame_dsn', None)
    final_settings['sentry'] = { 'frame_dsn': frame_dsn }

    frame_json['settings'] = final_settings
    return frame_json



def generate_scene_nim_source(frame: Frame, scene: Dict) -> str:
    from app.models.log import new_log as log
    available_apps = get_local_frame_apps()
    scene_id = scene.get('id', 'default')
    log(frame.id, "stdout", f"- Generating scene: {scene_id}")
    nodes = scene.get('nodes', [])
    nodes_by_id = {n['id']: n for n in nodes}
    imports = [
        # "import apps/unsplash/app as unsplashApp"
    ]
    scene_apps = [
        # "app_1: unsplashApp.App"
    ]
    init_apps = [
        # "result.app_1 = unsplashApp.init(config, unsplashApp.AppConfig(keyword: \"random\"))"
    ]
    render_nodes = [
        # "of 1:",
        # "  self.app_1.render(context)",
        # "  nextNode = 2",
    ]
    event_lines = [
        # "of \"render\":",
        # "  self.runNode(\"1\", context)",
    ]
    edges = scene.get('edges', [])
    event_nodes = {}
    next_nodes = {}
    for edge in edges:
        source = edge.get('source', None)
        target = edge.get('target', None)
        source_handle = edge.get('sourceHandle', None)
        target_handle = edge.get('targetHandle', None)
        if source and target and source_handle == 'next' and target_handle == 'prev':
            next_nodes[source] = target
    for node in nodes:
        node_id = node['id']
        if node.get('type') == 'event':
            event = node.get('data', {}).get('keyword', None)
            if event:
                if not event_nodes.get(event):
                    event_nodes[event] = []
                event_nodes[event].append(node)
        elif node.get('type') == 'app':
            name = node.get('data', {}).get('keyword', None)
            if name in available_apps:
                log(frame.id, "stdout", f"- Generating app: {name}")
                app_import = f"import apps/{name}/app as {name}App"
                if app_import not in imports:
                    imports += [app_import]
                app_id = "app_" + node_id.replace('-', '_')
                scene_apps += [
                    f"{app_id}: {name}App.App"
                ]

                app_config = node.get('data').get('config', {}).copy()
                config_path = os.path.join("../frame/src/apps", name, "config.json")
                config_types: Dict[str, str] = {}
                if os.path.exists(config_path):
                    with open(config_path, 'r') as file:
                        config = json.load(file)
                        for field in config.get('fields'):
                            key = field.get('name', None)
                            value = field.get('value', None)
                            config_types[key] = field.get('type', 'string')
                            if (key not in app_config or app_config.get(key) is None) and value is not None:
                                app_config[key] = value

                app_config_pairs = []
                for key, value in app_config.items():
                    if key not in config_types:
                        log(frame.id, "stderr",
                            f"- ERROR: Config key \"{key}\" not found for app \"{name}\", node \"{node_id}\"")
                        continue
                    type = config_types[key]

                    # TODO: sanitize
                    if isinstance(value, str):
                        if type == "integer":
                            app_config_pairs += [f"{key}: {int(value)}"]
                        elif type == "float":
                            app_config_pairs += [f"{key}: {float(value)}"]
                        elif type == "color":
                            app_config_pairs += [f"{key}: parseHtmlColor(\"{value}\")"]
                        else:
                            app_config_pairs += [f"{key}: \"{value}\""]
                    else:
                        app_config_pairs += [f"{key}: {value}"]

                init_apps += [
                    f"result.{app_id} = {name}App.init(frameOS, {name}App.AppConfig({', '.join(app_config_pairs)}))"
                ]
                render_nodes += [
                    f"of \"{node_id}\":",
                    f"  self.{app_id}.render(context)",
                    f"  nextNode = \"{next_nodes.get(node_id, '-1')}\""
                ]
            else:
                log(frame.id, "stderr", f"- ERROR: App not found: {name}")
    for event, nodes in event_nodes.items():
        event_lines += [f"of \"{event}\":", ]
        for node in nodes:
            next_node = next_nodes.get(node['id'], '-1')
            event_lines += [f"  self.runNode(\"{next_node}\", context)"]
    newline = "\n"
    scene_source = f"""
import pixie, json, times

from frameos/types import FrameOS, FrameScene, ExecutionContext
from frameos/logger import log
{newline.join(imports)}

let DEBUG = false

type Scene* = ref object of FrameScene
  state: JsonNode
  {(newline + "  ").join(scene_apps)}

proc init*(frameOS: FrameOS): Scene =
  result = Scene(frameOS: frameOS, frameConfig: frameOS.frameConfig, logger: frameOS.logger, state: %*{{}})
  {(newline + "  ").join(init_apps)}

proc runNode*(self: Scene, nodeId: string,
    context: var ExecutionContext) =
  var nextNode = nodeId
  var currentNode = nodeId
  var timer = epochTime()
  while nextNode != "-1":
    currentNode = nextNode
    timer = epochTime()
    case nextNode:
    {(newline + "    ").join(render_nodes)}
    else:
      nextNode = "-1"
    if DEBUG:
      self.logger.log(%*{{"event": "runApp", "node": currentNode, "ms": (-timer + epochTime()) * 1000}})

proc dispatchEvent*(self: Scene, event: string, eventPayload:
    JsonNode): ExecutionContext =
  var context = ExecutionContext(scene: self, event: event,
      eventPayload: eventPayload)
  if event == "render":
    context.image = newImage(self.frameConfig.width, self.frameConfig.height)
  case event:
  {(newline + "  ").join(event_lines)}
  result = context

proc render*(self: Scene): Image =
  var context = dispatchEvent(self, "render", %*{{"json": "True"}})
  return context.image
"""
    return scene_source

