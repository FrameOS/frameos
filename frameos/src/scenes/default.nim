# This code is autogenerated

import pixie, json, times, strformat

import frameos/types
import frameos/channels
import apps/haSensor/app as haSensorApp
import apps/unsplash/app as unsplashApp
import apps/clock/app as clockApp
import apps/text/app as nodeApp2
import apps/ifElse/app as ifElseApp
import apps/text/app as textApp

const DEBUG = false
const PUBLIC_STATE_KEYS: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: haSensorApp.App
  node2: nodeApp2.App
  node3: unsplashApp.App
  node4: clockApp.App
  node5: ifElseApp.App
  node6: textApp.App

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
    of 1.NodeId: # haSensor
      self.node1.run(context)
      nextNode = 2.NodeId
    of 3.NodeId: # unsplash
      self.node3.appConfig.keyword = if state{"water_heater"}{"state"}.getStr == "heat": "fire" else: "snow"
      self.node3.run(context)
      nextNode = 4.NodeId
    of 4.NodeId: # clock
      self.node4.appConfig.offsetY = if state{"heatTimer"}.getStr == "": 0 else: -40
      self.node4.run(context)
      nextNode = 5.NodeId
    of 2.NodeId: # code
      self.node2.run(context)
      nextNode = 3.NodeId
    of 5.NodeId: # ifElse
      self.node5.appConfig.condition = state{"heatTimer"}.getStr != ""
      self.node5.run(context)
      nextNode = -1.NodeId
    of 6.NodeId: # text
      self.node6.appConfig.text = state{"heatTimer"}.getStr
      self.node6.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    if DEBUG:
      self.logger.log(%*{"event": "scene:debug:app", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    try: self.runNode(1.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 1, "error": $e.msg,
        "stacktrace": e.getStackTrace()})
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for key in PUBLIC_STATE_KEYS:
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  else: discard

proc init*(frameConfig: FrameConfig, logger: Logger, dispatchEvent: proc(event: string, payload: JsonNode)): Scene =
  var state = %*{"heatTimer": %*(""), "heatStart": %*(0.0)}
  let scene = Scene(frameConfig: frameConfig, logger: logger, state: state, dispatchEvent: dispatchEvent)
  let self = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  result = scene
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = haSensorApp.init(1.NodeId, scene, haSensorApp.AppConfig(cacheSeconds: 1.0,
      entityId: "water_heater.hot_water", stateKey: "water_heater", debug: false))
  scene.node3 = unsplashApp.init(3.NodeId, scene, unsplashApp.AppConfig(cacheSeconds: 3600.0, keyword: if state{
      "water_heater"}{"state"}.getStr == "heat": "fire" else: "snow"))
  scene.node4 = clockApp.init(4.NodeId, scene, clockApp.AppConfig(fontSize: 80.0, format: "HH:mm:ss", formatCustom: "",
      position: "center-center", offsetX: 0.0, offsetY: if state{"heatTimer"}.getStr == "": 0 else: -40, padding: 10.0,
      fontColor: parseHtmlColor("#ffffff"), borderColor: parseHtmlColor("#000000"), borderWidth: 1))
  scene.node2 = nodeApp2.init(2.NodeId, scene, nodeApp2.AppConfig())
  scene.node5 = ifElseApp.init(5.NodeId, scene, ifElseApp.AppConfig(condition: state{"heatTimer"}.getStr != "",
      thenNode: 6.NodeId, elseNode: 0.NodeId))
  scene.node6 = textApp.init(6.NodeId, scene, textApp.AppConfig(borderColor: parseHtmlColor("#000000"),
      fontColor: parseHtmlColor("#ff0000"), fontSize: 60.0, offsetY: 70.0, text: state{"heatTimer"}.getStr,
      position: "center-center", offsetX: 0.0, padding: 10.0, borderWidth: 1))
  runEvent(scene, context)

proc render*(self: Scene): Image =
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
  context.image.fill(self.frameConfig.backgroundColor)
  runEvent(self, context)
  return context.image
{.pop.}
