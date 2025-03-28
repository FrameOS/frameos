# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/text/app as render_textApp
import apps/logic/setAsState/app as logic_setAsStateApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_textApp.App
  node2: render_textApp.App
  node3: logic_setAsStateApp.App
  node4: logic_setAsStateApp.App
  node5: render_textApp.App
  node6: render_textApp.App
  node7: logic_setAsStateApp.App
  node8: render_textApp.App

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
    of 1.NodeId: # render/text
      self.node1.appConfig.text = state{"setField"}.getStr()
      self.node1.run(context)
      nextNode = 2.NodeId
    of 2.NodeId: # render/text
      self.node2.appConfig.text = state{"unknown"}.getStr()
      self.node2.run(context)
      nextNode = 3.NodeId
    of 3.NodeId: # logic/setAsState
      self.node3.run(context)
      nextNode = 4.NodeId
    of 5.NodeId: # render/text
      self.node5.appConfig.text = state{"setField"}.getStr()
      self.node5.run(context)
      nextNode = 6.NodeId
    of 6.NodeId: # render/text
      self.node6.appConfig.text = state{"unknown"}.getStr()
      self.node6.run(context)
      nextNode = 7.NodeId
    of 4.NodeId: # logic/setAsState
      self.node4.run(context)
      nextNode = 5.NodeId
    of 7.NodeId: # logic/setAsState
      self.node7.appConfig.valueJson = %*{"key": "value"}
      self.node7.run(context)
      nextNode = 8.NodeId
    of 8.NodeId: # render/text
      self.node8.appConfig.text = state{"misc"}{"key"}.getStr()
      self.node8.run(context)
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
  var state = %*{"setField": %*("boo")}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_textApp.App(nodeName: "render/text", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    vAlign: "top",
    position: "left",
    inputImage: none(Image),
    text: state{"setField"}.getStr(),
    richText: "disabled",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  scene.node2 = render_textApp.App(nodeName: "render/text", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    position: "right",
    vAlign: "top",
    inputImage: none(Image),
    text: state{"unknown"}.getStr(),
    richText: "disabled",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  scene.node3 = logic_setAsStateApp.App(nodeName: "logic/setAsState", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_setAsStateApp.AppConfig(
    stateKey: "setField",
    valueString: "chicken",
  ))
  scene.node5 = render_textApp.App(nodeName: "render/text", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    position: "left",
    inputImage: none(Image),
    text: state{"setField"}.getStr(),
    richText: "disabled",
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
  scene.node6 = render_textApp.App(nodeName: "render/text", nodeId: 6.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    position: "right",
    inputImage: none(Image),
    text: state{"unknown"}.getStr(),
    richText: "disabled",
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
  scene.node4 = logic_setAsStateApp.App(nodeName: "logic/setAsState", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_setAsStateApp.AppConfig(
    valueString: "potato",
    stateKey: "unknown",
  ))
  scene.node7 = logic_setAsStateApp.App(nodeName: "logic/setAsState", nodeId: 7.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: logic_setAsStateApp.AppConfig(
    stateKey: "misc",
  ))
  scene.node8 = render_textApp.App(nodeName: "render/text", nodeId: 8.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    position: "left",
    vAlign: "bottom",
    inputImage: none(Image),
    text: state{"misc"}{"key"}.getStr(),
    richText: "disabled",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
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
