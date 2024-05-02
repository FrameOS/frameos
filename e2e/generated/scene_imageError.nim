# This file is autogenerated

import pixie, json, times, strformat

import frameos/types
import frameos/channels
import apps/downloadImage/app as downloadImageApp
import apps/text/app as textApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: downloadImageApp.App
  node2: textApp.App

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
    of 1.NodeId: # downloadImage
      self.node1.run(context)
      nextNode = 2.NodeId
    of 2.NodeId: # text
      self.node2.run(context)
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
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#ff00ff"))
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = downloadImageApp.init(1.NodeId, scene.FrameScene, downloadImageApp.AppConfig(url: "https://frameos.net/assets/images/frameos-e2e-scenes-imageError-must-be-404.jpg", scalingMode: "cover", cacheSeconds: 3600.0))
  scene.node2 = textApp.init(2.NodeId, scene.FrameScene, textApp.AppConfig(text: "Activate proton beam", position: "center-center", offsetX: 0.0, offsetY: 0.0, padding: 10.0, fontColor: parseHtmlColor("#ffffff"), fontSize: 32.0, borderColor: parseHtmlColor("#000000"), borderWidth: 1, overflow: "fit-bounds"))
  runEvent(context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
