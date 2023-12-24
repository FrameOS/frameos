import pixie, json

from frameos/types import Config, FrameScene, ExecutionContext
import apps/unsplash/app as unsplashApp
import apps/text/app as textApp

type Scene* = ref object of FrameScene
  state: JsonNode
  app_1: unsplashApp.App
  app_2: textApp.App

proc init*(config: Config): Scene =
  result = Scene(config: config, state: %*{})
  result.app_1 = unsplashApp.init(config, unsplashApp.AppConfig(
      keyword: "random"))
  result.app_2 = textApp.init(config, textApp.AppConfig(
      text: "Hello"))
  result.state["bla"] = %*"bla"

proc runNode*(self: Scene, nodeId: string,
    context: var ExecutionContext) =
  var nextNode = nodeId
  while nextNode != "-1":
    case nextNode:
    of "1":
      self.app_1.render(context)
      nextNode = "2"
    of "2":
      self.app_2.render(context)
      nextNode = "-1"
    else:
      nextNode = "-1"

proc dispatchEvent*(self: Scene, event: string, eventPayload:
    JsonNode): ExecutionContext =
  var context = ExecutionContext(scene: self, event: event,
      eventPayload: eventPayload)
  if event == "render":
    context.image = newImage(self.config.width, self.config.height)
  case event:
  of "render":
    self.runNode("1", context)
  result = context


proc render*(self: Scene): Image =
  var context = dispatchEvent(self, "render", %*{"json": "True"})
  return context.image
