import json
import os
from typing import Dict

from app.models.frame import Frame
from app.models.apps import get_local_frame_apps, local_apps_path
from app.codegen.utils import sanitize_nim_string

def write_scene_nim(frame: Frame, scene: Dict) -> str:
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
                    if (key not in app_config or app_config.get(key) is None) and (
                            value is not None or field_type == 'node'):
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
  context.image.fill(self.frameConfig.backgroundColor)
  runEvent(self, context)
  return context.image
{{.pop.}}
"""
    return scene_source

