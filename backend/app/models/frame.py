import json
import os
import uuid
import secrets
from app import db, socketio
from typing import Dict, Optional
from sqlalchemy.dialects.sqlite import JSON

from app.models.apps import get_app_configs, get_local_frame_apps, local_apps_path
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
    if frame := Frame.query.get(frame_id):
        # delete corresonding log and metric entries first
        from .log import Log
        Log.query.filter_by(frame_id=frame_id).delete()
        from .metrics import Metrics
        Metrics.query.filter_by(frame_id=frame_id).delete()

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
    frame_json = {
        "framePort": frame.frame_port or 8787,
        "serverHost": frame.server_host or "localhost",
        "serverPort": frame.server_port or 8989,
        "serverApiKey": frame.server_api_key,
        "width": frame.width,
        "height": frame.height,
        "device": frame.device or "web_only",
        "color": frame.color or "black",
        "backgroundColor": frame.background_color or "white",
        "interval": frame.interval or 30.0,
        "metricsInterval": frame.metrics_interval or 60.0,
        "scalingMode": frame.scaling_mode or "cover",
        "rotate": frame.rotate or 0,
    }

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

    frame_json['settings'] = final_settings
    return frame_json

def sanitize_nim_string(string: str) -> str:
    return string.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')

def generate_scene_nim_source(frame: Frame, scene: Dict) -> str:
    from app.models.log import new_log as log
    available_apps = get_local_frame_apps()
    scene_id = scene.get('id', 'default')
    log(frame.id, "stdout", f"- Generating scene: {scene_id}")
    nodes = scene.get('nodes', [])
    nodes_by_id = {n['id']: n for n in nodes}
    imports = []
    scene_object_fields = []
    init_apps = []
    render_nodes = []
    event_lines = []
    edges = scene.get('edges', [])
    event_nodes = {}
    next_nodes = {}
    field_inputs: Dict[str, Dict[str, str]] = {}
    node_fields: Dict[str, Dict[str, str]] = {}
    for edge in edges:
        source = edge.get('source', None)
        target = edge.get('target', None)
        source_handle = edge.get('sourceHandle', None)
        target_handle = edge.get('targetHandle', None)
        if source and target:
            if source_handle == 'next' and target_handle == 'prev':
                next_nodes[source] = target
            if source_handle == 'fieldOutput' and target_handle.startswith('fieldInput/'):
                field = target_handle.replace('fieldInput/', '')
                if not field_inputs.get(target):
                    field_inputs[target] = {}
                code_node = nodes_by_id.get(source)
                if code_node:
                    field_inputs[target][field] = code_node.get('data', {}).get('code', "")
            if source_handle.startswith('field/') and target_handle == 'prev':
                field = source_handle.replace('field/', '')
                if not node_fields.get(source):
                    node_fields[source] = {}
                node_fields[source][field] = target                

    for node in nodes:
        node_id = node['id']
        if node.get('type') == 'event':
            event = node.get('data', {}).get('keyword', None)
            if event:
                if not event_nodes.get(event):
                    event_nodes[event] = []
                event_nodes[event].append(node)
        elif node.get('type') == 'app':
            sources = node.get('data', {}).get('sources', {})
            name = node.get('data', {}).get('keyword', f"app_{node_id}")
            app_id = "app_" + node_id.replace('-', '_')

            if name in available_apps or len(sources) > 0:
                if len(sources) > 0:
                    log(frame.id, "stdout", f"- Generating source app: {node_id}")
                    node_app_id = "nodeapp_" + node_id.replace('-', '_')
                    app_import = f"import apps/{node_app_id}/app as {node_app_id}App"
                    scene_object_fields += [f"{app_id}: {node_app_id}App.App"]
                else:
                    log(frame.id, "stdout", f"- Generating app: {node_id} ({name})")
                    app_import = f"import apps/{name}/app as {name}App"
                    scene_object_fields += [f"{app_id}: {name}App.App"]

                if app_import not in imports:
                    imports += [app_import]

                app_config = node.get('data', {}).get('config', {}).copy()
                if len(sources) > 0 and sources.get('config.json', None):
                    config = json.loads(sources.get('config.json'))
                else:
                    config_path = os.path.join(local_apps_path, name, "config.json")
                    if os.path.exists(config_path):
                        with open(config_path, 'r') as file:
                            config = json.load(file)
                    else:
                        config = {}

                config_types: Dict[str, str] = {}
                for field in config.get('fields'):
                    key = field.get('name', None)
                    value = field.get('value', None)
                    field_type = field.get('type', 'string')
                    config_types[key] = field_type
                    if (key not in app_config or app_config.get(key) is None) and (value is not None or field_type == 'node'):
                        app_config[key] = value

                field_inputs_for_node = field_inputs.get(node_id, {})
                node_fields_for_node = node_fields.get(node_id, {})

                app_config_pairs = []
                for key, value in app_config.items():
                    if key not in config_types:
                        log(frame.id, "stderr",
                            f"- ERROR: Config key \"{key}\" not found for app \"{name}\", node \"{node_id}\"")
                        continue
                    type = config_types[key]

                    # TODO: sanitize
                    if key in field_inputs_for_node:
                        app_config_pairs += [f"{key}: {field_inputs_for_node[key]}"]
                    elif type == "node" and key in node_fields_for_node:
                        app_config_pairs += [f"{key}: \"{sanitize_nim_string(node_fields_for_node[key])}\""]
                    elif type == "node" and key not in node_fields_for_node:
                        app_config_pairs += [f"{key}: \"\""]
                    elif type == "integer":
                        app_config_pairs += [f"{key}: {int(value)}"]
                    elif type == "float":
                        app_config_pairs += [f"{key}: {float(value)}"]
                    elif type == "boolean":
                        app_config_pairs += [f"{key}: {'true' if value == 'true' else 'false'}"]
                    elif type == "color":
                        app_config_pairs += [f"{key}: parseHtmlColor(\"{sanitize_nim_string(str(value))}\")"]
                    elif type == "node":
                        app_config_pairs += [f"{key}: \"-1\""]
                    else:
                        app_config_pairs += [f"{key}: \"{sanitize_nim_string(str(value))}\""]

                if len(sources) > 0:
                    node_app_id = "nodeapp_" + node_id.replace('-', '_')
                    init_apps += [
                        f"scene.{app_id} = {node_app_id}App.init(\"{node_id}\", scene, {node_app_id}App.AppConfig({', '.join(app_config_pairs)}))"
                    ]
                else:
                    init_apps += [
                        f"scene.{app_id} = {name}App.init(\"{node_id}\", scene, {name}App.AppConfig({', '.join(app_config_pairs)}))"
                    ]

                render_nodes += [
                    f"of \"{node_id}\":",
                ]
                for key, code in field_inputs_for_node.items():
                    render_nodes += [f"  self.{app_id}.appConfig.{key} = {code}"]

                render_nodes += [
                    f"  self.{app_id}.run(context)",
                    f"  nextNode = \"{next_nodes.get(node_id, '-1')}\""
                ]
            else:
                log(frame.id, "stderr", f"- ERROR: App not found: {name}")
    for event, nodes in event_nodes.items():
        event_lines += [f"of \"{event}\":", ]
        for node in nodes:
            next_node = next_nodes.get(node['id'], '-1')
            event_lines += [f"  try: self.runNode(\"{next_node}\", context)"]
            event_lines += [f"  except Exception as e: self.logger.log(%*{{\"event\": \"event:error\","]
            event_lines += [f"      \"node\": \"{next_node}\","]
            event_lines += [f"      \"error\": $e.msg, \"stacktrace\": e.getStackTrace()}})"]
    newline = "\n"
    scene_source = f"""
import pixie, json, times, strformat

from frameos/types import FrameOS, FrameConfig, Logger, FrameScene, ExecutionContext
{newline.join(imports)}

const DEBUG = false

type Scene* = ref object of FrameScene
  {(newline + "  ").join(scene_object_fields)}

{{.push hint[XDeclaredButNotUsed]: off.}}
# This makes strformat available within the scene's inline code and avoids the "unused import" error
discard &""

proc runNode*(self: Scene, nodeId: string,
    context: var ExecutionContext) =
  let scene = self
  let frameConfig = scene.frameConfig
  let state = scene.state
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
      
proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  {(newline + "  ").join(event_lines)}
  else: discard

proc init*(frameConfig: FrameConfig, logger: Logger, dispatchEvent: proc(
    event: string, payload: JsonNode)): Scene =
  var state = %*{{}}
  let scene = Scene(frameConfig: frameConfig, logger: logger, state: state,
      dispatchEvent: dispatchEvent)
  let self = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: %*{{
    }}, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  result = scene
  scene.execNode = (proc(nodeId: string, context: var ExecutionContext) = self.runNode(nodeId, context))
  {(newline + "  ").join(init_apps)}
  runEvent(scene, context)

proc render*(self: Scene): Image =
  var context = ExecutionContext(
    scene: self,
    event: "render",
    payload: %*{{}},
    image: case self.frameConfig.rotate:
    of 90, 270: newImage(self.frameConfig.height, self.frameConfig.width)
    else: newImage(self.frameConfig.width, self.frameConfig.height),
    loopIndex: 0, 
    loopKey: "."
  )
  runEvent(self, context)
  return context.image
{{.pop.}}
"""
    return scene_source

