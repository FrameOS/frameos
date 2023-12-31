# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.
import json
import pixie
import assets/web as webAssets
import asyncdispatch, jester
from net import Port
import options
from frameos/types import FrameOS, FrameConfig, Logger, Server, RunnerControl
from frameos/runner import lastRender, triggerRender, getLastImage

var globalLogger: Logger
var globalFrameConfig: FrameConfig
var globalRunner: RunnerControl

proc match(request: Request): Future[ResponseData] {.async.} =
  echo "GET " & request.pathInfo
  {.cast(gcsafe).}: # TODO: is this correct? https://forum.nim-lang.org/t/10474
    block route:
      case request.pathInfo
      of "/", "/kiosk":
        resp Http200, webAssets.getAsset("assets/web/index.html")
      of "/event/render":
        globalRunner.triggerRender()
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/event/turnOn":
        globalRunner.sendEvent("turnOn", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/event/turnOff":
        globalRunner.sendEvent("turnOff", %*{})
        resp Http200, {"Content-Type": "application/json"}, $(%*{
            "status": "ok"})
      of "/image":
        globalLogger.log(%*{"event": "http", "path": "/image"})
        resp Http200, {"Content-Type": "image/png"}, globalRunner.getLastImage().encodeImage(PngFormat)
      else:
        resp Http404, "Not found!"


proc newServer*(frameOS: FrameOS): Server =
  globalFrameConfig = frameOS.frameConfig
  globalLogger = frameOS.logger
  globalRunner = frameOS.runner

  let port = (frameOS.frameConfig.framePort or 8787).Port
  let settings = newSettings(port = port)
  var jester = initJester(matcher = match.MatchProc, settings = settings)

  result = Server(
    frameConfig: frameOS.frameConfig,
    logger: frameOS.logger,
    runner: frameOS.runner,
    jester: jester,
  )

proc startServer*(self: Server) {.async.} =
  self.logger.log(%*{"event": "http:start",
      "message": "Starting web server"})
  self.jester.serve() # blocks forever
