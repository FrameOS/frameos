# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/opacity/app as render_opacityApp
import apps/data/localImage/app as data_localImageApp
import apps/render/split/app as render_splitApp
import apps/render/image/app as render_imageApp
import apps/data/newImage/app as data_newImageApp
import apps/render/color/app as render_colorApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_opacityApp.App
  node2: data_localImageApp.App
  node3: render_splitApp.App
  node4: render_imageApp.App
  node5: render_imageApp.App
  node6: render_imageApp.App
  node7: render_imageApp.App
  node8: render_imageApp.App
  node9: render_opacityApp.App
  node10: render_splitApp.App
  node11: data_newImageApp.App
  node12: render_colorApp.App
  node13: render_opacityApp.App

{.push hint[XDeclaredButNotUsed]: off.}
var cache0: Option[Image] = none(Image)
var cache0Time: float = 0
var cache1: Option[Image] = none(Image)

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
    of 3.NodeId: # render/split
      self.node3.run(context)
      nextNode = -1.NodeId
    of 8.NodeId: # render/image
      self.node8.appConfig.image = block:
        self.node1.appConfig.image = some(block:
          if cache0.isNone() or epochTime() > cache0Time + 900.0:
            cache0 = some(block:
              self.node2.get(context))
            cache0Time = epochTime()
          cache0.get())
        self.node1.get(context)
      self.node8.run(context)
      nextNode = -1.NodeId
    of 9.NodeId: # render/opacity
      self.node9.run(context)
      nextNode = -1.NodeId
    of 7.NodeId: # render/image
      self.node7.appConfig.image = block:
        self.node10.appConfig.inputImage = some(block:
          if cache1.isNone():
            cache1 = some(block:
              self.node11.get(context))
          cache1.get())
        self.node10.get(context)
      self.node7.run(context)
      nextNode = -1.NodeId
    of 12.NodeId: # render/color
      self.node12.run(context)
      nextNode = -1.NodeId
    of 6.NodeId: # render/image
      self.node6.appConfig.image = block:
        self.node13.get(context)
      self.node6.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/image
      self.node4.appConfig.image = block:
        self.node10.appConfig.inputImage = some(block:
          if cache1.isNone():
            cache1 = some(block:
              self.node11.get(context))
          cache1.get())
        self.node10.get(context)
      self.node4.run(context)
      nextNode = 8.NodeId
    of 5.NodeId: # render/image
      self.node5.appConfig.image = block:
        self.node10.appConfig.inputImage = some(block:
          if cache1.isNone():
            cache1 = some(block:
              self.node11.get(context))
          cache1.get())
        self.node10.get(context)
      self.node5.run(context)
      nextNode = 9.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "debug:scene", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    try: self.runNode(3.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 3, "error": $e.msg, "stacktrace": e.getStackTrace()})
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
  scene.node1 = render_opacityApp.App(nodeName: "render/opacity", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_opacityApp.AppConfig(
    opacity: 0.5,
  ))
  scene.node2 = data_localImageApp.App(nodeName: "data/localImage", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: data_localImageApp.AppConfig(
    path: "./assets/bird.png",
    order: "random",
    counterStateKey: "",
    search: "",
  ))
  scene.node2.init()
  scene.node3 = render_splitApp.App(nodeName: "render/split", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    columns: 2,
    rows: 2,
    inputImage: none(Image),
    hideEmpty: false,
    render_functions: @[
      @[
        4.NodeId,
        5.NodeId,
      ],
      @[
        6.NodeId,
        7.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node8 = render_imageApp.App(nodeName: "render/image", nodeId: 8.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    blendMode: "normal",
    inputImage: none(Image),
    placement: "cover",
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node9 = render_opacityApp.App(nodeName: "render/opacity", nodeId: 9.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_opacityApp.AppConfig(
    opacity: 0.5,
  ))
  scene.node7 = render_imageApp.App(nodeName: "render/image", nodeId: 7.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "tiled",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node11 = data_newImageApp.App(nodeName: "data/newImage", nodeId: 11.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: data_newImageApp.AppConfig(
    height: 40,
    width: 40,
    color: parseHtmlColor("#ffffff"),
    opacity: 1.0,
    renderNext: 0.NodeId,
  ))
  scene.node10 = render_splitApp.App(nodeName: "render/split", nodeId: 10.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    columns: 2,
    rows: 2,
    hideEmpty: true,
    inputImage: some(block:
      if cache1.isNone():
        cache1 = some(block:
          self.node11.get(context))
      cache1.get()),
    render_functions: @[
      @[
        12.NodeId,
        0.NodeId,
      ],
      @[
        0.NodeId,
        12.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node12 = render_colorApp.App(nodeName: "render/color", nodeId: 12.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_colorApp.AppConfig(
    color: parseHtmlColor("#ababab"),
    inputImage: none(Image),
  ))
  scene.node6 = render_imageApp.App(nodeName: "render/image", nodeId: 6.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    blendMode: "overwrite",
    placement: "tiled",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node13 = render_opacityApp.App(nodeName: "render/opacity", nodeId: 13.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_opacityApp.AppConfig(
    opacity: 0.5,
  ))
  scene.node4 = render_imageApp.App(nodeName: "render/image", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "tiled",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node5 = render_imageApp.App(nodeName: "render/image", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "tiled",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
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
