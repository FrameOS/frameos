import pixie, json, times, strformat

from frameos/types import FrameConfig, FrameScene, ExecutionContext
import apps/unsplash/app as unsplashApp
import apps/text/app as textApp

type Scene* = ref object of FrameScene
  state: JsonNode
  app_1: unsplashApp.App
  app_2: textApp.App

proc init*(frameConfig: FrameConfig): Scene =
  result = Scene(
    frameConfig: frameConfig,
    state: %*{},
    app_1: unsplashApp.init(frameConfig, unsplashApp.AppConfig(
      keyword: "random", cacheSeconds: "10")),
    app_2: textApp.init(frameConfig, textApp.AppConfig(
      text: "Hello")),
  )
  result.state["bla"] = %*"bla"

proc runNode*(self: Scene, nodeId: string,
    context: var ExecutionContext) =
  var nextNode = nodeId
  var currentNode = nodeId
  var nodeTimer = 0.0
  while nextNode != "-1":
    nodeTimer = epochTime()
    currentNode = nextNode
    case nextNode:
    of "1":
      self.app_1.render(context)
      nextNode = "2"
    of "2":
      self.app_2.render(context)
      nextNode = "-1"
    else:
      nextNode = "-1"
    echo &"Time taken to run app {currentNode}: {(epochTime() - nodeTimer) * 1000} ms"

proc dispatchEvent*(self: Scene, event: string, eventPayload:
    JsonNode): ExecutionContext =
  var context = ExecutionContext(scene: self, event: event,
      eventPayload: eventPayload)
  echo "Dispatching event: " & event
  if event == "render":
    context.image = newImage(self.frameConfig.width, self.frameConfig.height)
  case event:
  of "render":
    self.runNode("1", context)
  result = context


proc render*(self: Scene): Image =
  var context = dispatchEvent(self, "render", %*{"json": "True"})
  return context.image
