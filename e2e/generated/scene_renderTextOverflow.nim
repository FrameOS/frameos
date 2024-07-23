# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/gradient/app as render_gradientApp
import apps/render/text/app as render_textApp
import apps/render/split/app as render_splitApp
import apps/logic/setAsState/app as logic_setAsStateApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_gradientApp.App
  node2: render_textApp.App
  node3: render_splitApp.App
  node4: render_gradientApp.App
  node5: render_textApp.App
  node6: logic_setAsStateApp.App

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
    of 1.NodeId: # render/gradient
      self.node1.run(context)
      nextNode = 2.NodeId
    of 2.NodeId: # render/text
      self.node2.appConfig.text = state{"text"}.getStr()
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/split
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/gradient
      self.node4.run(context)
      nextNode = 5.NodeId
    of 5.NodeId: # render/text
      self.node5.appConfig.text = state{"text"}.getStr()
      self.node5.run(context)
      nextNode = -1.NodeId
    of 6.NodeId: # logic/setAsState
      self.node6.appConfig.valueString = "this is a frame in which ".repeat(100)
      self.node6.run(context)
      nextNode = 3.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "debug:scene", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(context: var ExecutionContext) =
  let self = Scene(context.scene)
  case context.event:
  of "render":
    try: self.runNode(6.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 6, "error": $e.msg, "stacktrace": e.getStackTrace()})
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
  var state = %*{"text": %*("")}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_gradientApp.App(nodeName: "render/gradient", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_gradientApp.AppConfig(
    startColor: parseHtmlColor("#57802d"),
    endColor: parseHtmlColor("#114b38"),
    inputImage: none(Image),
    angle: 45.0,
  ))
  scene.node2 = render_textApp.App(nodeName: "render/text", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    inputImage: none(Image),
    text: state{"text"}.getStr(),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  scene.node2.init()
  scene.node3 = render_splitApp.App(nodeName: "render/split", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    rows: 2,
    inputImage: none(Image),
    columns: 1,
    hideEmpty: false,
    render_functions: @[
      @[
        4.NodeId,
      ],
      @[
        1.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node4 = render_gradientApp.App(nodeName: "render/gradient", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_gradientApp.AppConfig(
    endColor: parseHtmlColor("#81081c"),
    inputImage: none(Image),
    startColor: parseHtmlColor("#800080"),
    angle: 45.0,
  ))
  scene.node5 = render_textApp.App(nodeName: "render/text", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    overflow: "visible",
    inputImage: none(Image),
    text: state{"text"}.getStr(),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
  ))
  scene.node5.init()
  scene.node6 = logic_setAsStateApp.App(nodeName: "logic/setAsState", nodeId: 6.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_setAsStateApp.AppConfig(
    stateKey: "text",
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
