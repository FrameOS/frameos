import json
import os
import math
import re

from app.models.frame import Frame
from app.models.apps import get_local_frame_apps, local_apps_path
from app.codegen.utils import sanitize_nim_string, natural_keys

def get_events_schema() -> list[dict]:
    events_schema_path = os.path.join("..", "frontend", "schema", "events.json")
    if os.path.exists(events_schema_path):
        with open(events_schema_path, 'r') as file:
            return json.load(file)
    else:
        return []

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
    source_field_inputs: dict[str, dict[str, tuple[str, str]]] = {}
    node_fields: dict[str, dict[str, str]] = {}
    events_schema = get_events_schema()

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
            if target_handle == 'prev':
                if source_handle == 'next':
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
            if source_handle.startswith('field/') and target_handle.startswith('fieldInput/'):
                target_field = target_handle.replace('fieldInput/', '')
                source_field = source_handle.replace('field/', '')
                if not source_field_inputs.get(target):
                    source_field_inputs[target] = {}
                source_field_inputs[target][target_field] = (source, source_field)

    for node in nodes:
        node_id = node['id']
        if node.get('type') == 'event' or node.get('type') == 'dispatch':
            event = node.get('data', {}).get('keyword', None)
            if event:
                # only if a source node
                if node.get('type') == 'event' and node_id in next_nodes:
                    if not event_nodes.get(event):
                        event_nodes[event] = []
                    event_nodes[event].append(node)

                # only if a target node (plus legacy support for using 'event' as a target node)
                if node_id in prev_nodes:
                    node_integer = node_id_to_integer(node_id)
                    config = node.get('data', {}).get('config', {}).copy()
                    field_inputs_for_node = field_inputs.get(node_id, {})
                    source_field_inputs_for_node = source_field_inputs.get(node_id, {})
                    node_fields_for_node = node_fields.get(node_id, {})

                    event_schema = None
                    for schema in events_schema:
                        if schema.get('name') == event:
                            event_schema = schema
                            break

                    event_payload_pairs = []
                    if event_schema:
                        for field in event_schema.get('fields', []):
                            key = field.get('name', None)
                            if key not in config:
                                config[key] = field.get('value', None)
                            type = field.get('type', 'string')
                            value = config.get(key, None)

                            # TODO: add event seq fields when we get custom events that can support them
                            event_payload_pairs.append(sanitize_nim_field(key, type, value, field_inputs_for_node,
                                             node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, {}, True))

                    next_node_id = next_nodes.get(node_id, None)
                    run_node_lines += [
                        f"of {node_integer}.NodeId: # {event}",
                        f"  sendEvent(\"{sanitize_nim_string(event)}\", %*{'{'+(','.join(event_payload_pairs))+'}'})",
                        f"  nextNode = {-1 if next_node_id is None else node_id_to_integer(next_node_id)}.NodeId"
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
                app_import = f"import apps/{node_app_id}/app as nodeApp{node_id_to_integer(node_id)}"
                scene_object_fields += [f"{app_id}: nodeApp{node_id_to_integer(node_id)}.App"]
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

            # { field: [['key1', 'from', 'to'], ['key2', 1, 5]] }
            seq_fields_for_node: dict[str, list[list[str | int]]] = {}
            field_inputs_for_node = field_inputs.get(node_id, {})
            source_field_inputs_for_node = source_field_inputs.get(node_id, {})
            node_fields_for_node = node_fields.get(node_id, {})

            config_types: dict[str, str] = {}
            for field in config.get('fields'):
                key = field.get('name', None)
                value = field.get('value', None)
                field_type = field.get('type', 'string')
                config_types[key] = field_type
                seq = field.get('seq', None)
                # set defaults for missing values
                if (key not in app_config or app_config.get(key) is None) and (
                        value is not None or field_type == 'node') and seq is None:
                    app_config[key] = value
                # mark fields that are sequences of fields
                if seq is not None:
                    seq_fields_for_node[key] = seq
                    if key not in app_config:
                        app_config[key] = None

            # convert sequence field metadata from ["key", "from_key", "to_key"] to ["key", 1, 3]
            for key, seqs in seq_fields_for_node.items():
                for i, [seq_key, seq_from, seq_to] in enumerate(seqs):
                    if isinstance(seq_from, str):
                        seq_from = app_config.get(seq_from, None)
                        seqs[i][1] = int(seq_from)
                    if isinstance(seq_to, str):
                        seq_to = app_config.get(seq_to, None)
                        seqs[i][2] = int(seq_to)

            app_config_pairs = []
            for key, value in app_config.items():
                if key not in config_types:
                    log(frame.id, "stderr",
                        f"- ERROR: When generating scene {scene_id}. Config key \"{key}\" not found for app \"{name}\", node \"{node_id}\"")
                    continue
                type = config_types[key]

                app_config_pairs.append(sanitize_nim_field(key, type, value, field_inputs_for_node,
                                                              node_fields_for_node, source_field_inputs_for_node,
                                                              node_id_to_integer, seq_fields_for_node, False))

            if len(sources) > 0:
                init_apps += [
                    f"scene.{app_id} = nodeApp{node_id_to_integer(node_id)}.init({node_integer}.NodeId, scene.FrameScene, nodeApp{node_id_to_integer(node_id)}.AppConfig({', '.join(app_config_pairs)}))"
                ]
            else:
                init_apps += [
                    f"scene.{app_id} = {name}App.init({node_integer}.NodeId, scene.FrameScene, {name}App.AppConfig({', '.join(app_config_pairs)}))"
                ]

            run_node_lines += [
                f"of {node_integer}.NodeId: # {name}",
            ]
            for key, code in field_inputs_for_node.items():
                run_node_lines += [f"  self.{app_id}.appConfig.{key} = {code}"]
            for key, (source_id, source_key) in source_field_inputs_for_node.items():
                run_node_lines += [f"  self.{app_id}.appConfig.{key} = self.node{node_id_to_integer(source_id)}.appConfig.{source_key}"]

            next_node_id = next_nodes.get(node_id, None)
            run_node_lines += [
                f"  self.{app_id}.run(context)",
                f"  nextNode = {-1 if next_node_id is None else node_id_to_integer(next_node_id)}.NodeId"
            ]

    scene_object_fields.sort(key=natural_keys)

    set_scene_state_lines = [
        '  if context.payload.hasKey("state") and context.payload["state"].kind == JObject:',
        '    let payload = context.payload["state"]',
        '    for field in PUBLIC_STATE_FIELDS:',
        '      let key = field.name',
        '      if payload.hasKey(key) and payload[key] != self.state{key}:',
        '        self.state[key] = copy(payload[key])',
        '  if context.payload.hasKey("render"):',
        '    sendEvent("render", %*{})',
    ]

    for event, nodes in event_nodes.items():
        run_event_lines += [f"of \"{event}\":"]
        if event == 'setSceneState':
            run_event_lines += set_scene_state_lines
        for node in nodes:
            next_node = next_nodes.get(node['id'], '-1')
            run_event_lines += [f"  try: self.runNode({node_id_to_integer(next_node)}.NodeId, context)"]
            run_event_lines += [f"  except Exception as e: self.logger.log(%*{{\"event\": \"{sanitize_nim_string(event)}:error\","
                                f" \"node\": {node_id_to_integer(next_node)}, \"error\": $e.msg, \"stacktrace\": e.getStackTrace()}})"]
    if not event_nodes.get('setSceneState', None):
        run_event_lines += ["of \"setSceneState\":"]
        run_event_lines += set_scene_state_lines

    state_init_fields = []
    public_state_fields = []
    persisted_state_fields = []
    for field in scene.get('fields', []):
        name = field.get('name', '')
        if name == "":
            continue
        type = field.get('type', 'string')
        value = field.get('value', '')
        if type == 'integer':
            state_init_fields += [f"\"{sanitize_nim_string(name)}\": %*({int(value)})"]
        elif type == 'float':
            state_init_fields += [f"\"{sanitize_nim_string(name)}\": %*({float(value)})"]
        elif type == 'boolean':
            state_init_fields += [f"\"{sanitize_nim_string(name)}\": %*({'true' if value == 'true' else 'false'})"]
        elif type == 'json':
            try:
                json.loads(str(value))
                json_string = sanitize_nim_string(str(value))
            except ValueError:
                json_string = "null"
            state_init_fields += [f"\"{sanitize_nim_string(name)}\": parseJson(\"{json_string}\")"]
        else:
            state_init_fields += [f"\"{sanitize_nim_string(name)}\": %*(\"{sanitize_nim_string(str(value))}\")"]
        if field.get('access', 'private') == 'public':
            opts = ""
            if field.get('type', 'string') == 'select':
                opts = ", ".join([f"\"{sanitize_nim_string(option)}\"" for option in field.get('options', [])])

            public_state_fields.append(
                f"StateField(name: \"{sanitize_nim_string(field.get('name', ''))}\", " \
                f"label: \"{sanitize_nim_string(field.get('label', field.get('name', '')))}\", " \
                f"fieldType: \"{sanitize_nim_string(field.get('type', 'string'))}\", options: @[{opts}], " \
                f"placeholder: \"{sanitize_nim_string(field.get('placeholder', ''))}\", " \
                f"required: {'true' if field.get('required', False) else 'false'}, " \
                f"secret: {'true' if field.get('secret', False) else 'false'})"
            )
        if field.get('persist', 'memory') == 'disk':
            persisted_state_fields.append(f"\"{sanitize_nim_string(name)}\"")

    newline = "\n"
    if len(public_state_fields) > 0:
        public_state_fields_seq = "@[\n  " + (",\n  ".join([field for field in public_state_fields])) + "\n]"
    else:
        public_state_fields_seq = "@[]"

    # If there's an "open" event, dispatch it in init
    open_event_in_init = ""
    if len(event_nodes.get('open', [])) > 0:
        open_event_in_init = """var openContext = ExecutionContext(scene: scene, event: "open", payload: %*{"sceneId": sceneId}, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  runEvent(openContext)
"""

    refresh_interval = float(scene.get('settings', {}).get('refreshInterval', None) or frame.interval or 300)
    if math.isnan(refresh_interval):
        refresh_interval = 300.0
    if refresh_interval < 0.001:
        refresh_interval = 0.001
    scene_refresh_interval = str(refresh_interval)

    background_color = scene.get('settings', {}).get('backgroundColor', None)
    if background_color is None and frame.background_color is not None and frame.background_color.startswith('#'):
        background_color = frame.background_color
    if background_color is None:
        background_color = '#000000'
    scene_background_color = f"parseHtmlColor(\"{sanitize_nim_string(str(background_color))}\")"

    scene_source = f"""
import pixie, json, times, strformat

import frameos/types
import frameos/channels
{newline.join(imports)}

const DEBUG = {'true' if frame.debug else 'false'}
let PUBLIC_STATE_FIELDS*: seq[StateField] = {public_state_fields_seq}
let PERSISTED_STATE_KEYS*: seq[string] = @[{', '.join(persisted_state_fields)}]

type Scene* = ref object of FrameScene
  {(newline + "  ").join(scene_object_fields)}

{{.push hint[XDeclaredButNotUsed]: off.}}
# This makes strformat available within the scene's inline code and avoids the "unused import" error
discard &""

proc runNode*(self: Scene, nodeId: NodeId,
    context: var ExecutionContext) =
  let scene = self
  let frameConfig = scene.frameConfig
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

proc runEvent*(context: var ExecutionContext) =
  let self = Scene(context.scene)
  case context.event:
  {(newline + "  ").join(run_event_lines)}
  else: discard

proc render*(self: FrameScene): Image =
  let self = Scene(self)
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
  context.image.fill(self.backgroundColor)
  runEvent(context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{{{", ".join(state_init_fields)}}}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: {scene_refresh_interval}, backgroundColor: {scene_background_color})
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  {(newline + "  ").join(init_apps)}
  runEvent(context)
  {open_event_in_init}
{{.pop.}}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
"""
    return scene_source

def get_sequence_values(key, sequences, index, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node):
    seq_start = sequences[index][1]
    seq_end = sequences[index][2]
    response = []
    for i in range(seq_start, seq_end + 1):
        if index == len(sequences) - 1:
            response.append(
                sanitize_nim_value(
                    f"{key}[{i}]",
                    type,
                    value,
                    field_inputs_for_node,
                    node_fields_for_node,
                    source_field_inputs_for_node,
                    node_id_to_integer,
                    seq_fields_for_node
                )
            )
        else:
            response.append(get_sequence_values(f"{key}[{i}]", sequences, index + 1, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node))
    return "@[" + (", ".join(response)) + "]"

def sanitize_nim_value(key, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node) -> str:
    if key in seq_fields_for_node:
        sequences = seq_fields_for_node[key]
        return get_sequence_values(key, sequences, 0, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node)

    if key in field_inputs_for_node:
        return f"{field_inputs_for_node[key]}"
    elif key in source_field_inputs_for_node:
        (source_id, source_key) = source_field_inputs_for_node[key]
        return f"self.node{node_id_to_integer(source_id)}.appConfig.{source_key}"
    elif type == "node" and key in node_fields_for_node:
        outgoing_node_id = node_fields_for_node[key]
        return f"{node_id_to_integer(outgoing_node_id)}.NodeId"
    elif type == "node" and key not in node_fields_for_node:
        return "0.NodeId"
    elif type == "integer":
        return f"{0 if value is None else int(value)}"
    elif type == "float":
        return f"{0.0 if value is None else float(value)}"
    elif type == "boolean":
        return f"{'true' if value == 'true' else 'false'}"
    elif type == "color":
        return f"parseHtmlColor(\"{'#000000' if value is None else sanitize_nim_string(str(value))}\")"
    elif type == "scene":
        return f"\"{'' if value is None else sanitize_nim_string(str(value))}\".SceneId"
    else:
        return f"\"{'' if value is None else sanitize_nim_string(str(value))}\""

def sanitize_nim_field(key, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node, key_with_quotes: bool) -> str:
    key_str = f"\"{sanitize_nim_string(str(key))}\"" if key_with_quotes else sanitize_nim_string(str(key))
    value_str = sanitize_nim_value(key, type, value, field_inputs_for_node, node_fields_for_node, source_field_inputs_for_node, node_id_to_integer, seq_fields_for_node)
    return f"{key_str}: {value_str}"

def write_scenes_nim(frame: Frame) -> str:
    rows = []
    imports = []
    sceneOptionTuples = []
    default_scene = None
    for scene in frame.scenes:
        if default_scene is None:
            default_scene = scene
        if scene.get('default', False):
            default_scene = scene

        scene_id = scene.get('id', 'default')
        scene_id = re.sub(r'[^a-zA-Z0-9\-\_]', '_', scene_id)
        scene_id_import = re.sub(r'\W+', '', scene_id)
        imports.append(f"import scenes/scene_{scene_id_import} as scene_{scene_id_import}")
        rows.append(f"  result[\"{scene_id}\".SceneId] = scene_{scene_id_import}.exportedScene")
        sceneOptionTuples.append(f"  (\"{scene_id}\".SceneId, \"{scene.get('name', 'Default')}\"),")

    default_scene_id = default_scene.get('id', 'default')
    default_scene_id = re.sub(r'[^a-zA-Z0-9\-\_]', '_', default_scene_id)
    newline = "\n"

    scenes_source = f"""
import frameos/types
import tables
{newline.join(sorted(imports))}

let defaultSceneId* = "{default_scene_id}".SceneId

const sceneOptions* = [
{newline.join(sorted(sceneOptionTuples))}
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
{newline.join(sorted(rows))}
"""

    return scenes_source