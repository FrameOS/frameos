# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import apps/logic/ifElse/app as logic_ifElseApp
import apps/render/gradient/app as render_gradientApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: logic_ifElseApp.App
  node3: render_gradientApp.App
  node4: render_gradientApp.App
  node5: render_splitApp.App
  node6: render_splitApp.App
  node7: logic_ifElseApp.App
  node8: render_gradientApp.App

{.push hint[XDeclaredButNotUsed]: off.}


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
    of 1.NodeId: # render/split
      self.node1.run(context)
      nextNode = -1.NodeId
    of 2.NodeId: # logic/ifElse
      self.node2.appConfig.condition = context.loopIndex mod 2 == 0
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/gradient
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/gradient
      self.node4.run(context)
      nextNode = -1.NodeId
    of 5.NodeId: # render/split
      self.node5.run(context)
      nextNode = -1.NodeId
    of 6.NodeId: # render/split
      self.node6.run(context)
      nextNode = -1.NodeId
    of 7.NodeId: # logic/ifElse
      self.node7.appConfig.condition = context.loopIndex mod 3 == 0
      self.node7.run(context)
      nextNode = -1.NodeId
    of 8.NodeId: # render/gradient
      self.node8.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "debug:scene", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    try: self.runNode(5.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 5, "error": $e.msg, "stacktrace": e.getStackTrace()})
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
  else: discard

proc runEvent*(self: FrameScene, context: var ExecutionContext) =
    runEvent(Scene(self), context)

proc render*(self: FrameScene, context: var ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(self, context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.App(nodeName: "render/split", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    rows: 10,
    inputImage: none(Image),
    columns: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
    ],
    render_function: 2.NodeId,
  ))
  scene.node2 = logic_ifElseApp.App(nodeName: "logic/ifElse", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_ifElseApp.AppConfig(
    condition: context.loopIndex mod 2 == 0,
    thenNode: 3.NodeId,
    elseNode: 4.NodeId,
  ))
  scene.node3 = render_gradientApp.App(nodeName: "render/gradient", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#800000"),
    endColor: parseHtmlColor("#e534df"),
    inputImage: none(Image),
    angle: 45.0,
  ))
  scene.node4 = render_gradientApp.App(nodeName: "render/gradient", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#1ba179"),
    endColor: parseHtmlColor("#186d1e"),
    inputImage: none(Image),
    angle: 45.0,
  ))
  scene.node5 = render_splitApp.App(nodeName: "render/split", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    columns: 2,
    inputImage: none(Image),
    rows: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        1.NodeId,
        6.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node6 = render_splitApp.App(nodeName: "render/split", nodeId: 6.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    rows: 6,
    inputImage: none(Image),
    columns: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
      @[
        0.NodeId,
      ],
    ],
    render_function: 7.NodeId,
  ))
  scene.node7 = logic_ifElseApp.App(nodeName: "logic/ifElse", nodeId: 7.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_ifElseApp.AppConfig(
    condition: context.loopIndex mod 3 == 0,
    thenNode: 8.NodeId,
    elseNode: 0.NodeId,
  ))
  scene.node8 = render_gradientApp.App(nodeName: "render/gradient", nodeId: 8.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#ddeb24"),
    endColor: parseHtmlColor("#dbff29"),
    inputImage: none(Image),
    angle: 45.0,
  ))
  runEvent(self, context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
