# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import apps/render/image/app as render_imageApp
import apps/data/resizeImage/app as data_resizeImageApp
import apps/data/localImage/app as data_localImageApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: render_imageApp.App
  node3: render_imageApp.App
  node4: render_imageApp.App
  node5: render_imageApp.App
  node6: data_resizeImageApp.App
  node7: data_localImageApp.App
  node8: data_resizeImageApp.App
  node9: data_resizeImageApp.App
  node10: data_resizeImageApp.App

{.push hint[XDeclaredButNotUsed]: off.}
var cache0: Option[Image] = none(Image)
var cache0Time: float = 0

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
        self.node6.appConfig.image = block:
          if cache0.isNone() or epochTime() > cache0Time + 900.0:
            cache0 = some(block:
              self.node7.get(context))
            cache0Time = epochTime()
          cache0.get()
        self.node6.get(context)
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/image
      self.node3.appConfig.image = block:
        self.node8.appConfig.image = block:
          if cache0.isNone() or epochTime() > cache0Time + 900.0:
            cache0 = some(block:
              self.node7.get(context))
            cache0Time = epochTime()
          cache0.get()
        self.node8.get(context)
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/image
      self.node4.appConfig.image = block:
        self.node9.appConfig.image = block:
          if cache0.isNone() or epochTime() > cache0Time + 900.0:
            cache0 = some(block:
              self.node7.get(context))
            cache0Time = epochTime()
          cache0.get()
        self.node9.get(context)
      self.node4.run(context)
      nextNode = -1.NodeId
    of 5.NodeId: # render/image
      self.node5.appConfig.image = block:
        self.node10.appConfig.image = block:
          if cache0.isNone() or epochTime() > cache0Time + 900.0:
            cache0 = some(block:
              self.node7.get(context))
            cache0Time = epochTime()
          cache0.get()
        self.node10.get(context)
      self.node5.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "scene:debug:app", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(context: var ExecutionContext) =
  let self = Scene(context.scene)
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
  else: discard

proc render*(self: FrameScene, context: var ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(context)
  
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#ababab"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.init(1.NodeId, scene.FrameScene, render_splitApp.AppConfig(
    columns: 2,
    rows: 2,
    inputImage: none(Image),
    hideEmpty: false,
    render_functions: @[
      @[
        2.NodeId,
        3.NodeId,
      ],
      @[
        4.NodeId,
        5.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node2 = render_imageApp.init(2.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node6 = data_resizeImageApp.init(6.NodeId, scene.FrameScene, data_resizeImageApp.AppConfig(
    height: 100,
    width: 100,
    scalingMode: "contain",
  ))
  scene.node7 = data_localImageApp.init(7.NodeId, scene.FrameScene, data_localImageApp.AppConfig(
    path: "./assets/image.png",
    order: "random",
    seconds: 900.0,
    counterStateKey: "",
  ))
  scene.node3 = render_imageApp.init(3.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node8 = data_resizeImageApp.init(8.NodeId, scene.FrameScene, data_resizeImageApp.AppConfig(
    height: 100,
    scalingMode: "cover",
    width: 100,
  ))
  scene.node4 = render_imageApp.init(4.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node9 = data_resizeImageApp.init(9.NodeId, scene.FrameScene, data_resizeImageApp.AppConfig(
    height: 100,
    scalingMode: "stretch",
    width: 100,
  ))
  scene.node5 = render_imageApp.init(5.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node10 = data_resizeImageApp.init(10.NodeId, scene.FrameScene, data_resizeImageApp.AppConfig(
    height: 100,
    scalingMode: "center",
    width: 100,
  ))
  runEvent(context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)