# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import apps/render/gradient/app as render_gradientApp
import apps/render/image/app as render_imageApp
import apps/data/newImage/app as data_newImageApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: render_gradientApp.App
  node3: render_imageApp.App
  node4: render_imageApp.App
  node5: render_gradientApp.App
  node6: render_gradientApp.App
  node7: data_newImageApp.App

{.push hint[XDeclaredButNotUsed]: off.}
var cache0: Option[Image] = none(Image)

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
    of 2.NodeId: # render/gradient
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/image
      self.node3.appConfig.image = block:
        self.node5.get(context)
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/image
      self.node4.appConfig.image = block:
        self.node6.appConfig.inputImage = some(block:
          if cache0.isNone():
            cache0 = some(block:
              self.node7.get(context))
          cache0.get())
        self.node6.get(context)
      self.node4.run(context)
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
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 300.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.init(1.NodeId, scene.FrameScene, render_splitApp.AppConfig(
    columns: 3,
    gap: "10",
    inputImage: none(Image),
    rows: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        2.NodeId,
        3.NodeId,
        4.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node2 = render_gradientApp.init(2.NodeId, scene.FrameScene, render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#05a2d6"),
    endColor: parseHtmlColor("#eff312"),
    angle: 90.0,
    inputImage: none(Image),
  ))
  scene.node3 = render_imageApp.init(3.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node5 = render_gradientApp.init(5.NodeId, scene.FrameScene, render_gradientApp.AppConfig(
    inputImage: none(Image),
    startColor: parseHtmlColor("#800080"),
    endColor: parseHtmlColor("#ffc0cb"),
    angle: 45.0,
  ))
  scene.node4 = render_imageApp.init(4.NodeId, scene.FrameScene, render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
  ))
  scene.node7 = data_newImageApp.init(7.NodeId, scene.FrameScene, data_newImageApp.AppConfig(
    width: 40,
    height: 40,
    color: parseHtmlColor("#ffffff"),
  ))
  scene.node6 = render_gradientApp.init(6.NodeId, scene.FrameScene, render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#2f8d1c"),
    endColor: parseHtmlColor("#04390a"),
    inputImage: some(block:
      if cache0.isNone():
        cache0 = some(block:
          self.node7.get(context))
      cache0.get()),
    angle: 45.0,
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
