# This file is autogenerated

import pixie, json, times, strformat

import frameos/types
import frameos/channels
import apps/qr/app as qrApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: qrApp.App
  node2: qrApp.App
  node3: qrApp.App
  node4: qrApp.App
  node5: qrApp.App
  node6: qrApp.App
  node7: qrApp.App

{.push hint[XDeclaredButNotUsed]: off.}
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
    of 1.NodeId: # qr
      self.node1.run(context)
      nextNode = 2.NodeId
    of 2.NodeId: # qr
      self.node2.run(context)
      nextNode = 3.NodeId
    of 3.NodeId: # qr
      self.node3.run(context)
      nextNode = 4.NodeId
    of 4.NodeId: # qr
      self.node4.run(context)
      nextNode = 5.NodeId
    of 5.NodeId: # qr
      self.node5.run(context)
      nextNode = 6.NodeId
    of 6.NodeId: # qr
      self.node6.run(context)
      nextNode = 7.NodeId
    of 7.NodeId: # qr
      self.node7.run(context)
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

proc render*(self: FrameScene): Image =
  let self = Scene(self)
  var context = ExecutionContext(
    scene: self,
    event: "render",
    payload: %*{},
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
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 300.0, backgroundColor: parseHtmlColor("#000000"))
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = qrApp.init(1.NodeId, scene.FrameScene, qrApp.AppConfig(position: "top-left", alRad: 80.0, offsetX: 20.0, offsetY: 4.0, codeType: "Frame Control URL", code: "", size: 2.0, sizeUnit: "pixels per dot", moRad: 0.0, moSep: 0.0, padding: 1, qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff")))
  scene.node2 = qrApp.init(2.NodeId, scene.FrameScene, qrApp.AppConfig(codeType: "Frame Image URL", position: "top-center", alRad: 10.0, qrCodeColor: parseHtmlColor("#ffffff"), backgroundColor: parseHtmlColor("#000000"), code: "", size: 2.0, sizeUnit: "pixels per dot", moRad: 0.0, moSep: 0.0, offsetX: 0.0, offsetY: 0.0, padding: 1))
  scene.node3 = qrApp.init(3.NodeId, scene.FrameScene, qrApp.AppConfig(codeType: "Custom", code: "hello", position: "top-right", moSep: 80.0, backgroundColor: parseHtmlColor("#cc0000"), qrCodeColor: parseHtmlColor("#3544bb"), size: 5.0, sizeUnit: "pixels per dot", alRad: 30.0, moRad: 0.0, offsetX: 0.0, offsetY: 0.0, padding: 1))
  scene.node4 = qrApp.init(4.NodeId, scene.FrameScene, qrApp.AppConfig(codeType: "Custom", code: "world", position: "center-left", moRad: 100.0, size: 5.0, sizeUnit: "pixels per dot", alRad: 30.0, moSep: 0.0, offsetX: 0.0, offsetY: 0.0, padding: 1, qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff")))
  scene.node5 = qrApp.init(5.NodeId, scene.FrameScene, qrApp.AppConfig(moRad: 50.0, moSep: 50.0, sizeUnit: "pixels total", size: 100.0, codeType: "Frame Control URL", code: "", alRad: 30.0, position: "center-center", offsetX: 0.0, offsetY: 0.0, padding: 1, qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff")))
  scene.node6 = qrApp.init(6.NodeId, scene.FrameScene, qrApp.AppConfig(position: "center-right", moRad: 50.0, padding: 3, codeType: "Frame Control URL", code: "", size: 2.0, sizeUnit: "pixels per dot", alRad: 30.0, moSep: 0.0, offsetX: 0.0, offsetY: 0.0, qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff")))
  scene.node7 = qrApp.init(7.NodeId, scene.FrameScene, qrApp.AppConfig(position: "bottom-left", sizeUnit: "percent", size: 20.0, codeType: "Frame Control URL", code: "", alRad: 30.0, moRad: 0.0, moSep: 0.0, offsetX: 0.0, offsetY: 0.0, padding: 1, qrCodeColor: parseHtmlColor("#000000"), backgroundColor: parseHtmlColor("#ffffff")))
  runEvent(context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)