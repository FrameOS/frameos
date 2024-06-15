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
        with open(events_schema_path, "r") as file:
            return json.load(file)
    else:
        return []

def wrap_color(value: str) -> str:
    if (
        value.startswith("#")
        and len(value) == 7
        and all(c in "0123456789abcdefABCDEF" for c in value[1:])
    ):
        return f'parseHtmlColor("{value}")'
    raise ValueError(f"Invalid color value {value}")

def write_scene_nim(frame: Frame, scene: dict) -> str:
    return SceneWriter(frame, scene).write_scene_nim()


def field_type_to_nim_type(field_type: str) -> str:
    match field_type:
        case 'select':
            return 'string'
        case 'text':
            return 'string'
        case 'string':
            return 'string'
        case 'float':
            return 'float'
        case 'integer':
            return 'int'
        case 'boolean':
            return 'bool'
        case 'color':
            return 'Color'
        case 'json':
            return 'JsonNode'
        case 'node':
            return 'NodeId'
        case 'scene':
            return 'SceneId'
        case 'image':
            return 'Image'
        case _:
            raise ValueError(f"Invalid field type {field_type}")


class SceneWriter:
    events_schema = get_events_schema()
    available_apps: list[str]
    scene_id: str
    nodes: list
    nodes_by_id: dict
    app_configs: dict[str, dict]
    node_integer_map: dict[str, int]
    imports: list
    scene_object_fields: list
    init_apps: list
    run_node_lines: list
    after_node_lines: list
    run_event_lines: list
    edges: list
    event_nodes: dict
    next_nodes: dict
    prev_nodes: dict
    field_inputs: dict[str, dict[str, str]]
    code_field_source_nodes: dict[str, dict[str, str]]
    source_field_inputs: dict[str, dict[str, tuple[str, str]]]
    node_fields: dict[str, dict[str, str]]
    newline = "\n"
    cache_counter: int = 0
    cache_indexes: dict[str, int]
    cache_fields: list[str]

    def __init__(self, frame: Frame, scene: dict):
        self.available_apps = get_local_frame_apps()
        self.frame = frame
        self.scene = scene
        self.scene_id = scene.get("id", "default")
        self.nodes = scene.get("nodes", [])
        self.nodes_by_id = {n["id"]: n for n in self.nodes}
        self.app_configs = {}
        self.edges = scene.get("edges", [])
        self.node_integer_map = {}
        self.imports = []
        self.scene_object_fields = []
        self.init_apps = []
        self.run_node_lines = []
        self.after_node_lines = []
        self.run_event_lines = []
        self.event_nodes = {}
        self.next_nodes = {}
        self.prev_nodes = {}
        self.field_inputs = {}
        self.code_field_source_nodes = {}
        self.source_field_inputs = {}
        self.node_fields = {}
        self.app_node_outputs = {}
        self.cache_counter = 0
        self.cache_indexes = {}
        self.cache_fields = []


    def node_id_to_integer(self, node_id: str) -> int:
        if node_id not in self.node_integer_map:
            self.node_integer_map[node_id] = len(self.node_integer_map) + 1
        return self.node_integer_map[node_id]

    def write_scene_nim(self) -> str:
        self.apply_control_code()
        self.read_edges()
        self.read_nodes()
        return self.write_source()

    def apply_control_code(self):
        control_code = self.frame.control_code
        if control_code and control_code.get("enabled") == "true":
            self.scene_object_fields += ["controlCode: qrApp.App"]
            app_import = "import apps/render/qr/app as qrApp"
            if app_import not in self.imports:
                self.imports += [app_import]
            self.init_apps += [
                'scene.controlCode = qrApp.init(-1.NodeId, scene.FrameScene, qrApp.AppConfig(',
                f'  backgroundColor: parseHtmlColor("{sanitize_nim_string(control_code.get("backgroundColor", "#000000"))}"),',
                f'  qrCodeColor: parseHtmlColor("{sanitize_nim_string(control_code.get("qrCodeColor", "#ffffff"))}"),',
                f'  offsetX: {float(control_code.get("offsetX", "0"))},',
                f'  offsetY: {float(control_code.get("offsetY", "0"))},',
                f'  padding: {int(control_code.get("padding", "1"))},',
                f'  position: "{sanitize_nim_string(control_code.get("position", "top-left"))}",',
                f'  size: {float(control_code.get("size", "2"))},',
                '  codeType: "Frame Control URL",',
                '  code: "",',
                '  sizeUnit: "pixels per dot",',
                '  alRad: 30.0,',
                '  moRad: 0.0,',
                '  moSep: 0.0',
                '))'
            ]
            self.after_node_lines += ["self.controlCode.run(context)"]

    def read_edges(self):
        for edge in self.edges:
            source = edge.get("source", None)
            target = edge.get("target", None)
            source_handle = edge.get("sourceHandle", None)
            target_handle = edge.get("targetHandle", None)
            if source and target:
                # Default prev/next edge between app nodes.
                if source_handle == "next" and target_handle == "prev":
                    self.next_nodes[source] = target
                    self.prev_nodes[target] = source

                # Code node connecting to app node.
                if source_handle == "fieldOutput" and target_handle.startswith("fieldInput/"):
                    field = target_handle.replace("fieldInput/", "")
                    code_node = self.nodes_by_id.get(source)
                    if code_node:
                        if not self.field_inputs.get(target):
                            self.field_inputs[target] = {}
                        self.field_inputs[target][field] = code_node.get("data", {}).get("code", "")
                        if not self.code_field_source_nodes.get(target):
                            self.code_field_source_nodes[target] = {}
                        self.code_field_source_nodes[target][field] = source

                # Code node connecting to code node.
                if source_handle == "fieldOutput" and target_handle.startswith("codeField/"):
                    field = target_handle.replace("codeField/", "")
                    code_node = self.nodes_by_id.get(source)
                    if code_node:
                        if not self.code_field_source_nodes.get(target):
                            self.code_field_source_nodes[target] = {}
                        self.code_field_source_nodes[target][field] = source

                # App field's node connecting to app node (e.g. "then" and "else" in if/else)
                if source_handle.startswith("field/") and target_handle == "prev":
                    field = source_handle.replace("field/", "")
                    if not self.node_fields.get(source):
                        self.node_fields[source] = {}
                    self.node_fields[source][field] = target

                # Ad-hoc code nodes connecting to app field's inputs, e.g. state from a render event to an app
                # TODO: should stop using them?
                if source_handle.startswith("code/") and target_handle.startswith("fieldInput/"):
                    field = target_handle.replace("fieldInput/", "")
                    if not self.field_inputs.get(target):
                        self.field_inputs[target] = {}
                    self.field_inputs[target][field] = source_handle.replace("code/", "")

                # App field's output to another app field's input
                if source_handle.startswith("field/") and target_handle.startswith("fieldInput/"):
                    target_field = target_handle.replace("fieldInput/", "")
                    source_field = source_handle.replace("field/", "")
                    if not self.source_field_inputs.get(target):
                        self.source_field_inputs[target] = {}
                    self.source_field_inputs[target][target_field] = (source, source_field)

    def process_app_init(self, node):
        node_id = node["id"]
        sources = node.get("data", {}).get("sources", {})
        name = node.get("data", {}).get("keyword", f"app_{node_id}")
        name_identifier = name.replace("/", "_")
        app_id = f"node{self.node_id_to_integer(node_id)}"

        if name not in self.available_apps and len(sources) == 0:
            message = f'- ERROR: When generating scene {self.scene_id}. App "{name}" for node "{node_id}" not found'
            try:
                from app.models.log import new_log as log
                log(self.frame.id, "stderr", message)
                return
            except Exception:
                raise ValueError(message)

        if len(sources) > 0:
            node_app_id = "nodeapp_" + node_id.replace("-", "_")
            app_import = f"import apps/{node_app_id}/app as nodeApp{self.node_id_to_integer(node_id)}"
            self.scene_object_fields += [
                f"{app_id}: nodeApp{self.node_id_to_integer(node_id)}.App"
            ]
        else:
            app_import = f"import apps/{name}/app as {name_identifier}App"
            self.scene_object_fields += [f"{app_id}: {name_identifier}App.App"]

        if app_import not in self.imports:
            self.imports += [app_import]


    def process_app_run(self, node):
        node_id = node["id"]
        if node_id in self.app_configs:
            return

        sources = node.get("data", {}).get("sources", {})
        name = node.get("data", {}).get("keyword", f"app_{node_id}")
        node_integer = self.node_id_to_integer(node_id)
        app_id = f"node{node_integer}"

        app_config = node.get("data", {}).get("config", {}).copy()
        if len(sources) > 0 and sources.get("config.json", None):
            config = json.loads(sources.get("config.json"))
        else:
            config_path = os.path.join(local_apps_path, name, "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r") as file:
                    config = json.load(file)
            else:
                config = {}
        self.app_configs[node_id] = config

        # { field: [['key1', 'from', 'to'], ['key2', 1, 5]] }
        seq_fields_for_node: dict[str, list[list[str | int]]] = {}
        field_inputs_for_node = self.field_inputs.get(node_id, {})
        code_fields_for_node = self.code_field_source_nodes.get(node_id, {})
        source_field_inputs_for_node = self.source_field_inputs.get(node_id, {})
        node_fields_for_node = self.node_fields.get(node_id, {})

        config_types: dict[str, str] = {}
        for field in config.get("fields"):
            if field.get('markdown'):
                continue
            key = field.get("name", None)
            value = field.get("value", None)
            field_type = field.get("type", "string")
            config_types[key] = field_type
            seq = field.get("seq", None)
            # set defaults for missing values
            if (
                (key not in app_config or app_config.get(key) is None)
                and (value is not None or field_type == "node")
                and seq is None
            ):
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

        app_config_pairs: list[list[str]] = []
        for key, value in app_config.items():
            if key not in config_types:
                message = f'- ERROR: When generating scene {self.scene_id}. Config key "{key}" not found for app "{name}", node "{node_id}"'
                try:
                    from app.models.log import new_log as log
                    log(
                        self.frame.id,
                        "stderr",
                        message,
                    )
                    continue
                except Exception:
                    raise ValueError(message)
            type = config_types[key]

            app_config_pairs.append(
                [f"  {x}" for x in self.sanitize_nim_field(
                    node_id,
                    key,
                    type,
                    value,
                    field_inputs_for_node,
                    node_fields_for_node,
                    source_field_inputs_for_node,
                    seq_fields_for_node,
                    code_fields_for_node,
                    False,
                )]
            )

        if len(sources) > 0:
            appName = f"nodeApp{self.node_id_to_integer(node_id)}"
        else:
            name_identifier = name.replace("/", "_")
            appName = f"{name_identifier}App"
        self.init_apps += [
            f"scene.{app_id} = {appName}.init({node_integer}.NodeId, scene.FrameScene, {appName}.AppConfig(",
        ]
        for x in app_config_pairs:
            if len(x) > 0:
                for line in x:
                    self.init_apps += [line]
                self.init_apps[-1] = self.init_apps[-1] + ","
        self.init_apps += ['))']
        self.app_node_outputs[node_id] = config.get("output", None)

    def get_app_node_cacheable_fields_with_types(self, node_id) -> dict[str, str]:
        field_inputs_for_node = self.field_inputs.get(node_id, {})
        code_fields_for_node = self.code_field_source_nodes.get(node_id, {})
        app_config = self.app_configs[node_id]

        cache_fields: dict[str, str] = {}
        for key, code in field_inputs_for_node.items():
            if key in code_fields_for_node:
                fields = app_config.get('fields', [])
                for field in fields:
                    if field.get('name') == key:
                        cache_fields[key] = field_type_to_nim_type(field.get('type', 'string'))

        return cache_fields

    def process_app_run_lines(self, node, case_or_block = "case"):
        node_id = node["id"]
        name = node.get("data", {}).get("keyword", f"app_{node_id}")
        node_integer = self.node_id_to_integer(node_id)
        app_id = f"node{node_integer}"

        run_lines = []

        if case_or_block == "case":
            run_lines += [
                f"of {node_integer}.NodeId: # {name}",
            ]
        else:
            run_lines += [
                "block:",
            ]
        field_inputs_for_node = self.field_inputs.get(node_id, {})
        code_fields_for_node = self.code_field_source_nodes.get(node_id, {})
        source_field_inputs_for_node = self.source_field_inputs.get(node_id, {})

        for key, code in field_inputs_for_node.items():
            if key in code_fields_for_node:
                code_lines = self.get_code_field_value(code_fields_for_node[key])
                run_lines += [f"  self.{app_id}.appConfig.{key} = {code_lines[0]}"]
                for line in code_lines[1:]:
                    run_lines += [f"  {line}"]
            else:
                run_lines += [f"  self.{app_id}.appConfig.{key} = {code}"]

        for key, (source_id, source_key) in source_field_inputs_for_node.items():
            run_lines += [
                f"  self.{app_id}.appConfig.{key} = self.node{self.node_id_to_integer(source_id)}.appConfig.{source_key}"
            ]
        next_node_id = self.next_nodes.get(node_id, None)

        app_output = self.app_node_outputs.get(node_id, []) or []

        discard_or_not = "discard " if len(app_output) > 0 and case_or_block == "case" else ""
        output_field_access = f".{app_output[0].get('name', '')}" if len(app_output) > 1 else ""
        run_lines += [f"  {discard_or_not}self.{app_id}.run(context){output_field_access}"]

        if case_or_block == "case":
            run_lines += [
                f"  nextNode = {-1 if next_node_id is None else self.node_id_to_integer(next_node_id)}.NodeId",
            ]

        return run_lines

    def read_nodes(self):
        newline = "\n"
        for node in self.nodes:
            node_id = node["id"]
            if node.get("type") == "event" or node.get("type") == "dispatch":
                event = node.get("data", {}).get("keyword", None)
                if event:
                    # only if a source node
                    if node.get("type") == "event" and node_id in self.next_nodes:
                        if not self.event_nodes.get(event):
                            self.event_nodes[event] = []
                        self.event_nodes[event].append(node)

                    # only if a target node (plus legacy support for using 'event' as a target node)
                    if node_id in self.prev_nodes:
                        node_integer = self.node_id_to_integer(node_id)
                        config = node.get("data", {}).get("config", {}).copy()
                        field_inputs_for_node = self.field_inputs.get(node_id, {})
                        source_field_inputs_for_node = self.source_field_inputs.get(node_id, {})
                        node_fields_for_node = self.node_fields.get(node_id, {})

                        event_schema = None
                        for schema in self.events_schema:
                            if schema.get("name") == event:
                                event_schema = schema
                                break

                        event_payload_pairs: list[list[str]] = []
                        if event_schema:
                            for field in event_schema.get("fields", []):
                                key = field.get("name", None)
                                if key not in config:
                                    config[key] = field.get("value", None)
                                type = field.get("type", "string")
                                value = config.get(key, None)

                                event_payload_pairs.append(
                                    [f"  {x}" for x in self.sanitize_nim_field(
                                        node_id,
                                        key,
                                        type,
                                        value,
                                        field_inputs_for_node,
                                        node_fields_for_node,
                                        source_field_inputs_for_node,
                                        {},
                                        True,
                                    )]
                                )

                        next_node_id = self.next_nodes.get(node_id, None)
                        self.run_node_lines += [
                            f"of {node_integer}.NodeId: # {event}",
                            f"  sendEvent(\"{sanitize_nim_string(event)}\", %*{'{'}",
                            *[f"    {('    ' + newline).join(x)}," for x in event_payload_pairs],
                            "})",
                            f"  nextNode = {-1 if next_node_id is None else self.node_id_to_integer(next_node_id)}.NodeId",
                        ]

            elif node.get("type") == "app":
                self.process_app_init(node)
                self.process_app_run(node)

                app_outputs = self.app_node_outputs.get(node_id, []) or []

                # Ignore if it's a data node that's used elsewhere.
                # Otherwise, add this node to the big case statement
                if len(app_outputs) == 0:
                    self.run_node_lines += self.process_app_run_lines(node, "case")

        self.scene_object_fields.sort(key=natural_keys)

        set_scene_state_lines = [
            '  if context.payload.hasKey("state") and context.payload["state"].kind == JObject:',
            '    let payload = context.payload["state"]',
            "    for field in PUBLIC_STATE_FIELDS:",
            "      let key = field.name",
            "      if payload.hasKey(key) and payload[key] != self.state{key}:",
            "        self.state[key] = copy(payload[key])",
            '  if context.payload.hasKey("render"):',
            '    sendEvent("render", %*{})',
        ]

        for event, nodes in self.event_nodes.items():
            self.run_event_lines += [f'of "{event}":']
            if event == "setSceneState":
                self.run_event_lines += set_scene_state_lines
            for node in nodes:
                next_node = self.next_nodes.get(node["id"], "-1")
                self.run_event_lines += [
                    f"  try: self.runNode({self.node_id_to_integer(next_node)}.NodeId, context)",
                    f'  except Exception as e: self.logger.log(%*{{"event": "{sanitize_nim_string(event)}:error", ' +
                    f'"node": {self.node_id_to_integer(next_node)}, "error": $e.msg, "stacktrace": e.getStackTrace()}})'
                ]
        if not self.event_nodes.get("setSceneState", None):
            self.run_event_lines += ['of "setSceneState":']
            self.run_event_lines += set_scene_state_lines

    def write_source(self) -> str:
        state_init_fields = []
        public_state_fields = []
        persisted_state_fields = []
        for field in self.scene.get("fields", []):
            name = field.get("name", "")
            if name == "":
                continue
            type = field.get("type", "string")
            value = field.get("value", "")
            if type == "integer":
                state_init_fields += [f'"{sanitize_nim_string(name)}": %*({int(value)})']
            elif type == "float":
                state_init_fields += [f'"{sanitize_nim_string(name)}": %*({float(value)})']
            elif type == "boolean":
                state_init_fields += [
                    f"\"{sanitize_nim_string(name)}\": %*({'true' if value == 'true' else 'false'})"
                ]
            elif type == "json":
                try:
                    json.loads(str(value))
                    json_string = sanitize_nim_string(str(value))
                except ValueError:
                    json_string = "null"
                state_init_fields += [
                    f'"{sanitize_nim_string(name)}": parseJson("{json_string}")'
                ]
            else:
                state_init_fields += [
                    f'"{sanitize_nim_string(name)}": %*("{sanitize_nim_string(str(value))}")'
                ]
            if field.get("access", "private") == "public":
                opts = ""
                if field.get("type", "string") == "select":
                    opts = ", ".join(
                        [
                            f'"{sanitize_nim_string(option)}"'
                            for option in field.get("options", [])
                        ]
                    )

                public_state_fields.append(
                    f"StateField(name: \"{sanitize_nim_string(field.get('name', ''))}\", "
                    f"label: \"{sanitize_nim_string(field.get('label', field.get('name', '')))}\", "
                    f"fieldType: \"{sanitize_nim_string(field.get('type', 'string'))}\", options: @[{opts}], "
                    f"placeholder: \"{sanitize_nim_string(field.get('placeholder', ''))}\", "
                    f"required: {'true' if field.get('required', False) else 'false'}, "
                    f"secret: {'true' if field.get('secret', False) else 'false'})"
                )
            if field.get("persist", "memory") == "disk":
                persisted_state_fields.append(f'"{sanitize_nim_string(name)}"')

        newline = "\n"
        if len(public_state_fields) > 0:
            public_state_fields_seq = (
                "@[\n  " + (",\n  ".join([field for field in public_state_fields])) + "\n]"
            )
        else:
            public_state_fields_seq = "@[]"

        # If there's an "open" event, dispatch it in init
        open_event_in_init = ""
        if len(self.event_nodes.get("open", [])) > 0:
            open_event_in_init = """var openContext = ExecutionContext(scene: scene, event: "open", payload: %*{"sceneId": sceneId}, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
      runEvent(openContext)
    """

        refresh_interval = float(
            self.scene.get("settings", {}).get("refreshInterval", None) or self.frame.interval or 300
        )
        if math.isnan(refresh_interval):
            refresh_interval = 300.0
        if refresh_interval < 0.001:
            refresh_interval = 0.001
        scene_refresh_interval = str(refresh_interval)

        background_color = self.scene.get("settings", {}).get("backgroundColor", None)
        if (
            background_color is None
            and self.frame.background_color is not None
            and self.frame.background_color.startswith("#")
        ):
            background_color = self.frame.background_color
        if background_color is None:
            background_color = "#000000"
        scene_background_color = wrap_color(sanitize_nim_string(str(background_color)))

        scene_source = f"""
{{.warning[UnusedImport]: off.}}
import pixie, json, times, strformat, strutils, sequtils, options

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
{newline.join(self.imports)}

const DEBUG = {'true' if self.frame.debug else 'false'}
let PUBLIC_STATE_FIELDS*: seq[StateField] = {public_state_fields_seq}
let PERSISTED_STATE_KEYS*: seq[string] = @[{', '.join(persisted_state_fields)}]

type Scene* = ref object of FrameScene
  {(newline + "  ").join(self.scene_object_fields)}

{{.push hint[XDeclaredButNotUsed]: off.}}
{newline.join(self.cache_fields)}

proc runNode*(self: Scene, nodeId: NodeId, context: var ExecutionContext) =
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
    {(newline + "    ").join(self.run_node_lines)}
    else:
      nextNode = -1.NodeId
    {(newline + "    ").join(self.after_node_lines)}
    if DEBUG:
      self.logger.log(%*{{"event": "scene:debug:app", "node": currentNode, "ms": (-timer + epochTime()) * 1000}})

proc runEvent*(context: var ExecutionContext) =
  let self = Scene(context.scene)
  case context.event:
  {(newline + "  ").join(self.run_event_lines)}
  else: discard

proc render*(self: FrameScene, context: var ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{{{", ".join(state_init_fields)}}}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: {scene_refresh_interval}, backgroundColor: {scene_background_color})
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  {(newline + "  ").join(self.init_apps)}
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


    def sanitize_nim_value(
        self,
        node_id,
        key,
        type,
        value,
        field_inputs_for_node,
        node_fields_for_node,
        source_field_inputs_for_node,
        seq_fields_for_node,
        code_fields_for_node,
    ) -> list[str]:
        if key in seq_fields_for_node:
            sequences = seq_fields_for_node[key]
            return self.get_sequence_values(
                node_id,
                key,
                sequences,
                0,
                type,
                value,
                field_inputs_for_node,
                node_fields_for_node,
                source_field_inputs_for_node,
                seq_fields_for_node,
                code_fields_for_node,
            )

        if key in field_inputs_for_node:
            if key in code_fields_for_node:
                return self.get_code_field_value(code_fields_for_node[key])

            return [f"{field_inputs_for_node[key]}"]
        elif key in source_field_inputs_for_node:
            (source_id, source_key) = source_field_inputs_for_node[key]
            return [f"self.node{self.node_id_to_integer(source_id)}.appConfig.{source_key}"]
        elif type == "node" and key in node_fields_for_node:
            outgoing_node_id = node_fields_for_node[key]
            return [f"{self.node_id_to_integer(outgoing_node_id)}.NodeId"]
        elif type == "node" and key not in node_fields_for_node:
            return ["0.NodeId"]
        elif type == "integer":
            return [f"{0 if value is None else int(value or '0')}"]
        elif type == "float":
            return [f"{0.0 if value is None else float(value or '0')}"]
        elif type == "boolean":
            return [f"{'true' if value == 'true' else 'false'}"]
        elif type == "color":
            try:
                return [wrap_color(
                    "#000000" if value is None else sanitize_nim_string(str(value))
                )]
            except ValueError:
                raise ValueError(f"Invalid color value {value} for key {key}")
        elif type == "scene":
            return [f"\"{'' if value is None else sanitize_nim_string(str(value))}\".SceneId"]
        else:
            return [f"\"{'' if value is None else sanitize_nim_string(str(value))}\""]

    def get_sequence_values(
        self,
        node_id,
        key,
        sequences,
        index,
        type,
        value,
        field_inputs_for_node,
        node_fields_for_node,
        source_field_inputs_for_node,
        seq_fields_for_node,
        code_fields_for_node,
    ) -> list[str]:
        seq_start = sequences[index][1]
        seq_end = sequences[index][2]
        response = []
        for i in range(seq_start, seq_end + 1):
            if index == len(sequences) - 1:
                response.append(
                    self.sanitize_nim_value(
                        node_id,
                        f"{key}[{i}]",
                        type,
                        value,
                        field_inputs_for_node,
                        node_fields_for_node,
                        source_field_inputs_for_node,
                        seq_fields_for_node,
                        code_fields_for_node,
                    )
                )
            else:
                response.append(
                    self.get_sequence_values(
                        node_id,
                        f"{key}[{i}]",
                        sequences,
                        index + 1,
                        type,
                        value,
                        field_inputs_for_node,
                        node_fields_for_node,
                        source_field_inputs_for_node,
                        seq_fields_for_node,
                        code_fields_for_node,
                    )
                )

        result = ["@["]
        for x in response:
            if isinstance(x, str):
                raise ValueError("Invalid sequence value")
            for line in x:
                result += ['  ' + line]
            if len(x) > 0:
                result[-1] = result[-1] + ","
        result += ["]"]
        return result

    def sanitize_nim_field(
        self,
        node_id,
        key,
        type,
        value,
        field_inputs_for_node,
        node_fields_for_node,
        source_field_inputs_for_node,
        seq_fields_for_node,
        code_fields_for_node,
        key_with_quotes: bool,
    ) -> list[str]:
        key_str = (
            f'"{sanitize_nim_string(str(key))}"'
            if key_with_quotes
            else sanitize_nim_string(str(key))
        )
        value_list = self.sanitize_nim_value(
            node_id,
            key,
            type,
            value,
            field_inputs_for_node,
            node_fields_for_node,
            source_field_inputs_for_node,
            seq_fields_for_node,
            code_fields_for_node,
        )

        if len(value_list) == 0:
            return []
        if len(value_list) > 1:
            return [
                f"{key_str}: {value_list[0]}",
                *[f"{x}" for x in value_list[1:]],
            ]
        return [
            f"{key_str}: {value_list[0]}"
        ]

    def get_code_field_value(self, node_id, depth = 0) -> list[str]:
        if depth > 100:
            raise ValueError("Code field recursion limit reached")
        node = self.nodes_by_id.get(node_id)
        if node:
            if node.get("type") == "app":
                self.process_app_run(node)
                code = self.process_app_run_lines(node, "block")
            else:
                code = [node.get("data", {}).get("code", "")]
            cache_type = node.get("data", {}).get('cache', {}).get('type', 'none')
            code_fields = node.get("data", {}).get("codeArgs", [])
            if code_fields and len(code_fields) > 0:
                source_lines = ["block:"]
                code_field_sources = self.code_field_source_nodes.get(node_id, {}) or {}
                for code_field in code_fields:
                    field = code_field.get('name')
                    if field in code_field_sources:
                        code_field_source = self.get_code_field_value(code_field_sources[field], depth + 1)

                        if len(code_field_source) == 1:
                            source_lines += [f"  let {field} = {code_field_source[0]}"]
                        elif len(code_field_source) > 1:
                            source_lines += [f"  let {field} = {code_field_source[0]}"]
                            source_lines += [f"  {x}" for x in code_field_source[1:]]
                        else:
                            raise ValueError("Invalid code field source")

                if cache_type in ('duration', 'keyDuration', 'key', 'input', 'inputDuration'):
                    code = self.wrap_with_cache(node_id, code, node.get("data", {}))

                for line in code:
                    source_lines += ["  " + line]
                result = source_lines
            else:
                if cache_type in ('duration', 'keyDuration', 'key', 'input', 'inputDuration'):
                    code = self.wrap_with_cache(node_id, code, node.get("data", {}))
                result = code

            if cache_type == 'forever':
                result = self.wrap_with_cache(node_id, result, node.get("data", {}))

            return result

    def wrap_with_cache(self, node_id: str, value_list: list[str], data: dict):
        cache_type = data.get('cache', {}).get('type', 'none')

        if cache_type == 'none':
            return value_list

        # unique key
        if node_id in self.cache_indexes:
            cache_index = self.cache_indexes[node_id]
        else:
            cache_index = self.cache_counter
            self.cache_indexes[node_id] = cache_index
            self.cache_counter += 1
        cache_field = f"cache{cache_index}"

        # data type
        cache_data_type = 'string'
        if self.app_configs.get(node_id) is not None:
            app_config = self.app_configs[node_id]
            if app_config.get('output') is not None and len(app_config.get('output')) > 0:
                output = app_config['output'][0]
                cache_data_type = output.get('type', 'string')
        if cache_data_type in ['string', 'float']:
            pass
        elif cache_data_type == 'integer':
            cache_data_type = 'int'
        elif cache_data_type == 'image':
            cache_data_type = 'Image'
        else:
            cache_data_type = 'JsonNode'

        # where to store the cached data
        cache_var = f"var {cache_field}: Option[{cache_data_type}] = none({cache_data_type})"
        if cache_var not in self.cache_fields:
            self.cache_fields += [cache_var]

        cache_conditions = f"{cache_field}.isNone()"
        extra_pre_lines = []
        extra_post_lines = []

        # duration
        if cache_type == 'duration' or cache_type == 'keyDuration' or cache_type == 'inputDuration':
            cache_duration = float(data.get('cache', {}).get('duration', 60))
            time_var = f"var {cache_field}Time: float = 0"
            if time_var not in self.cache_fields:
                self.cache_fields += [time_var]
            cache_conditions += f" or epochTime() > {cache_field}Time + {cache_duration}"
            extra_post_lines += [f"    {cache_field}Time = epochTime()"]

        # expression
        if cache_type == 'key' or cache_type == 'keyDuration':
            cache_key = data.get('cache', {}).get('keySource', '"string"')
            cache_key_data_type = field_type_to_nim_type(data.get('cache', {}).get('keyDataType', 'string'))

            key_var = f"var {cache_field}Expr: {cache_key_data_type}"
            if key_var not in self.cache_fields:
                self.cache_fields += [key_var]
            extra_pre_lines += [f"  let {cache_field}ExprNew: {cache_key_data_type} = {cache_key}"]
            cache_conditions += f" or {cache_field}Expr != {cache_field}ExprNew"
            extra_post_lines += [f"    {cache_field}Expr = {cache_field}ExprNew"]

        # input fields
        if cache_type == 'input' or cache_type == 'inputDuration':
            node = self.nodes_by_id.get(node_id)
            if node.get("type") == "app":
                cache_fields = self.get_app_node_cacheable_fields_with_types(node_id)
            else:
                raise NotImplementedError("Input cache for non-app nodes not implemented")

            if len(cache_fields) > 0:
                app_id = f"node{self.node_id_to_integer(node_id)}"
                cache_key = ", ".join(map(lambda x: f"self.{app_id}.appConfig.{x}", cache_fields.keys()))
                cache_key_data_type = ", ".join(cache_fields.values())
                if len(cache_fields) > 1:
                    cache_key = f"({cache_key})"
                    cache_key_data_type = f"({cache_key_data_type})"

                key_var = f"var {cache_field}Fields: {cache_key_data_type} # {', '.join(cache_fields.keys())}"
                if key_var not in self.cache_fields:
                    self.cache_fields += [key_var]
                cache_conditions += f" or {cache_field}Fields != {cache_key}"
                extra_post_lines += [f"    {cache_field}Fields = {cache_key}"]

        value_list[-1] = value_list[-1] + ')'
        value_list = [
            "block:",
            *extra_pre_lines,
            f"  if {cache_conditions}:",
            f"    {cache_field} = some({value_list[0]}",
            *[f"    {x}" for x in value_list[1:]],
            *extra_post_lines,
            f"  {cache_field}.get()",
        ]

        return value_list


def write_scenes_nim(frame: Frame) -> str:
    rows = []
    imports = []
    sceneOptionTuples = []
    default_scene = None
    for scene in frame.scenes:
        if scene.get("default", False):
            default_scene = scene

        scene_id = scene.get("id", "default")
        scene_id = re.sub(r"[^a-zA-Z0-9\-\_]", "_", scene_id)
        scene_id_import = re.sub(r"\W+", "", scene_id)
        imports.append(
            f"import scenes/scene_{scene_id_import} as scene_{scene_id_import}"
        )
        rows.append(
            f'  result["{scene_id}".SceneId] = scene_{scene_id_import}.exportedScene'
        )
        sceneOptionTuples.append(
            f"  (\"{scene_id}\".SceneId, \"{scene.get('name', 'Default')}\"),"
        )

    default_scene_id = (
        default_scene.get("id", None) if default_scene is not None else None
    )
    if default_scene_id is None:
        default_scene_line = "let defaultSceneId* = none(SceneId)"
    else:
        default_scene_id = re.sub(r"[^a-zA-Z0-9\-\_]", "_", default_scene_id)
        default_scene_line = f'let defaultSceneId* = some("{default_scene_id}".SceneId)'

    newline = "\n"
    scenes_source = f"""
import frameos/types
import tables, options
{newline.join(sorted(imports))}

{default_scene_line}

const sceneOptions* = [
{newline.join(sorted(sceneOptionTuples))}
]

proc getExportedScenes*(): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
{newline.join(sorted(rows))}
"""

    return scenes_source
