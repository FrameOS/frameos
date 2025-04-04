# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import apps/render/image/app as render_imageApp
import apps/render/color/app as render_colorApp
import apps/data/resizeImage/app as data_resizeImageApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: render_imageApp.App
  node3: render_colorApp.App
  node4: data_resizeImageApp.App
  node5: render_colorApp.App

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
    of 2.NodeId: # render/image
      self.node2.appConfig.image = block:
        self.node4.appConfig.image = block:
          self.node5.get(context)
        self.node4.get(context)
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/color
      self.node3.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "debug:scene", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    try: self.runNode(1.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 1, "error": $e.msg, "stacktrace": e.getStackTrace()})
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
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 300.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.App(nodeName: "render/split", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    columns: 2,
    inputImage: none(Image),
    rows: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        2.NodeId,
        3.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node2 = render_imageApp.App(nodeName: "render/image", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node4 = data_resizeImageApp.App(nodeName: "data/resizeImage", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: data_resizeImageApp.AppConfig(
    width: 200,
    height: 200,
    scalingMode: "center",
  ))
  scene.node5 = render_colorApp.App(nodeName: "render/color", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_colorApp.AppConfig(
    color: parseHtmlColor("#d62424"),
    inputImage: none(Image),
  ))
  scene.node3 = render_colorApp.App(nodeName: "render/color", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_colorApp.AppConfig(
    color: parseHtmlColor("#e6d40f"),
    inputImage: none(Image),
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
