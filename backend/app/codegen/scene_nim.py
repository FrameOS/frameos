import json
import os

from app.models.frame import Frame
from app.models.apps import get_local_frame_apps, local_apps_path
from app.codegen.utils import sanitize_nim_string, natural_keys


def write_scene_nim(frame: Frame, scene: dict) -> str:
    from app.models.log import new_log as log
    available_apps = get_local_frame_apps()
    scene_id = scene.get('id', 'default')
    nodes = scene.get('nodes', [])
    nodes_by_id = {n['id']: n for n in nodes}
    node_integer_map: dict[str, int] = {}
    imports = []
    scene_object_fields = []
    init_apps = []
    run_node_lines = []
    run_event_lines = []
    edges = scene.get('edges', [])
    event_nodes = {}
    next_nodes = {}
    prev_nodes = {}
    field_inputs: dict[str, dict[str, str]] = {}
    node_fields: dict[str, dict[str, str]] = {}

    def node_id_to_integer(node_id: str) -> int:
        if node_id not in node_integer_map:
            node_integer_map[node_id] = len(node_integer_map) + 1
        return node_integer_map[node_id]

    for edge in edges:
        source = edge.get('source', None)
        target = edge.get('target', None)
        source_handle = edge.get('sourceHandle', None)
        target_handle = edge.get('targetHandle', None)
        if source and target:
            if source_handle == 'next' and target_handle == 'prev':
                next_nodes[source] = target
                prev_nodes[target] = source
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
            if source_handle.startswith('code/') and target_handle.startswith('fieldInput/'):
                field = target_handle.replace('fieldInput/', '')
                if not field_inputs.get(target):
                    field_inputs[target] = {}
                field_inputs[target][field] = source_handle.replace('code/', '')

    for node in nodes:
        node_id = node['id']
        if node.get('type') == 'event':
            event = node.get('data', {}).get('keyword', None)
            if event:
                # only if a source node
                if node_id in next_nodes:
                    if not event_nodes.get(event):
                        event_nodes[event] = []
                    event_nodes[event].append(node)

                # only if a target node
                if node_id in prev_nodes:
                    node_integer = node_id_to_integer(node_id)
                    run_node_lines += [
                        f"of {node_integer}.NodeId: # {event}",
                        f"  sendEvent(\"{sanitize_nim_string(event)}\", %*{'{}'})",
                        "  nextNode = -1.NodeId"
                    ]

        elif node.get('type') == 'app':
            sources = node.get('data', {}).get('sources', {})
            name = node.get('data', {}).get('keyword', f"app_{node_id}")
            node_integer = node_id_to_integer(node_id)
            app_id = f"node{node_integer}"

            if name not in available_apps and len(sources) == 0:
                log(frame.id, "stderr", f"- ERROR: When generating scene {scene_id}. App \"{name}\" for node \"{node_id}\" not found")
                continue

            if len(sources) > 0:
                node_app_id = "nodeapp_" + node_id.replace('-', '_')
                app_import = f"import apps/{node_app_id}/app as nodeApp{node_id_to_integer(node_app_id)}"
                scene_object_fields += [f"{app_id}: nodeApp{node_id_to_integer(node_app_id)}.App"]
            else:
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

            config_types: dict[str, str] = {}
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
                        f"- ERROR: When generating scene {scene_id}. Config key \"{key}\" not found for app \"{name}\", node \"{node_id}\"")
                    continue
                type = config_types[key]

                if key in field_inputs_for_node:
                    app_config_pairs += [f"{key}: {field_inputs_for_node[key]}"]
                elif type == "node" and key in node_fields_for_node:
                    outgoing_node_id = node_fields_for_node[key]
                    app_config_pairs += [f"{key}: {node_id_to_integer(outgoing_node_id)}.NodeId"]
                elif type == "node" and key not in node_fields_for_node:
                    app_config_pairs += [f"{key}: 0.NodeId"]
                elif type == "integer":
                    app_config_pairs += [f"{key}: {int(value)}"]
                elif type == "float":
                    app_config_pairs += [f"{key}: {float(value)}"]
                elif type == "boolean":
                    app_config_pairs += [f"{key}: {'true' if value == 'true' else 'false'}"]
                elif type == "color":
                    app_config_pairs += [f"{key}: parseHtmlColor(\"{sanitize_nim_string(str(value))}\")"]
                elif type == "node":
                    app_config_pairs += [f"{key}: -1.NodeId"]
                else:
                    app_config_pairs += [f"{key}: \"{sanitize_nim_string(str(value))}\""]

            if len(sources) > 0:
                node_app_id = "nodeapp_" + node_id.replace('-', '_')
                init_apps += [
                    f"scene.{app_id} = nodeApp{node_id_to_integer(node_app_id)}.init({node_integer}.NodeId, scene, nodeApp{node_id_to_integer(node_app_id)}.AppConfig({', '.join(app_config_pairs)}))"
                ]
            else:
                init_apps += [
                    f"scene.{app_id} = {name}App.init({node_integer}.NodeId, scene, {name}App.AppConfig({', '.join(app_config_pairs)}))"
                ]

            run_node_lines += [
                f"of {node_integer}.NodeId: # {name}",
            ]
            for key, code in field_inputs_for_node.items():
                run_node_lines += [f"  self.{app_id}.appConfig.{key} = {code}"]

            next_node_id = next_nodes.get(node_id, None)
            run_node_lines += [
                f"  self.{app_id}.run(context)",
                f"  nextNode = {-1 if next_node_id is None else node_id_to_integer(next_node_id)}.NodeId"
            ]

    scene_object_fields.sort(key=natural_keys)

    for event, nodes in event_nodes.items():
        run_event_lines += [f"of \"{event}\":", ]
        for node in nodes:
            next_node = next_nodes.get(node['id'], '-1')
            run_event_lines += [f"  try: self.runNode({node_id_to_integer(next_node)}.NodeId, context)"]
            run_event_lines += [f"  except Exception as e: self.logger.log(%*{{\"event\": \"{sanitize_nim_string(event)}:error\","]
            run_event_lines += [f"      \"node\": {node_id_to_integer(next_node)}, \"error\": $e.msg, \"stacktrace\": e.getStackTrace()}})"]


    scene_config_fields = []
    scene_config_init_fields = []
    for field in scene.get('fields', []):
        type = field.get('type', 'string')
        name = field.get('name', '')
        value = field.get('value', '')
        if type == 'integer':
            scene_config_fields += [f"{name}*: int"]
            scene_config_init_fields += [f"{name}: {int(value)}"]
        elif type == 'float':
            scene_config_fields += [f"{name}*: float"]
            scene_config_init_fields += [f"{name}: {float(value)}"]
        elif type == 'boolean':
            scene_config_fields += [f"{name}*: bool"]
            scene_config_init_fields += [f"{name}: {'true' if value == 'true' else 'false'}"]
        elif type == 'color':
            scene_config_fields += [f"{name}*: Color"]
            scene_config_init_fields += [f"{name}: parseHtmlColor(\"{sanitize_nim_string(str(value))}\")"]
        else:
            scene_config_fields += [f"{name}*: string"]
            scene_config_init_fields += [f"{name}: \"{sanitize_nim_string(str(value))}\""]

    newline = "\n"
    scene_source = f"""
import pixie, json, times, strformat

import frameos/types
import frameos/channels
{newline.join(imports)}

const DEBUG = {'true' if frame.debug else 'false'}

type Config* = ref object of SceneConfig
  {(newline + "  ").join(scene_config_fields) if len(scene_config_fields) > 0 else "discard"}

type Scene* = ref object of FrameScene
  sceneConfig*: Config
  {(newline + "  ").join(scene_object_fields)}

{{.push hint[XDeclaredButNotUsed]: off.}}
# This makes strformat available within the scene's inline code and avoids the "unused import" error
discard &""

proc runNode*(self: Scene, nodeId: NodeId,
    context: var ExecutionContext) =
  let scene = self
  let frameConfig = scene.frameConfig
  let sceneConfig = Config(scene.sceneConfig)
  let state = scene.state
  var nextNode = nodeId
  var currentNode = nodeId
  var timer = epochTime()
  while nextNode != -1.NodeId:
    currentNode = nextNode
    timer = epochTime()
    case nextNode:
    {(newline + "    ").join(run_node_lines)}
    else:
      nextNode = -1.NodeId
    if DEBUG:
      self.logger.log(%*{{"event": "scene:debug:app", "node": currentNode, "ms": (-timer + epochTime()) * 1000}})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  {(newline + "  ").join(run_event_lines)}
  else: discard

proc init*(frameConfig: FrameConfig, logger: Logger, dispatchEvent: proc(
    event: string, payload: JsonNode)): Scene =
  var state = %*{{}}
  let sceneConfig = Config({", ".join(scene_config_init_fields)})
  let scene = Scene(frameConfig: frameConfig, sceneConfig: sceneConfig, logger: logger, state: state,
      dispatchEvent: dispatchEvent)
  let self = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: %*{{
    }}, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  result = scene
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = self.runNode(nodeId, context))
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
