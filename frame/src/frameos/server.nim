# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.
import json
import pixie
import assets/web as webAssets
import asyncdispatch, jester
from net import Port
import options
from frameos/types import Config, Logger, Server, Renderer
from frameos/logger import log
from frameos/renderer import renderScene

var globalLogger: Logger
var globalConfig: Config
var globalRenderer: Renderer

proc match(request: Request): ResponseData =
  {.cast(gcsafe).}: # TODO: is this correct? https://forum.nim-lang.org/t/10474
    block route:
      case request.pathInfo
      of "/", "/kiosk":
        resp Http200, webAssets.getAsset("assets/web/index.html")
      of "/image":
        globalLogger.log(%*{"event": "http", "path": "/image"})
        let image = globalRenderer.renderScene()
        resp Http200, {"Content-Type": "image/png"}, image.encodeImage(PngFormat)
      else:
        resp Http404, "Not found!"

proc newServer*(config: Config, logger: Logger, renderer: Renderer): Server =
  globalConfig = config
  globalLogger = logger
  globalRenderer = renderer

  let port = (config.framePort or 8787).Port
  let settings = newSettings(port = port)
  var jester = initJester(matcher = match.MatchProcSync, settings = settings)
  result = Server(config: config, logger: logger, jester: jester,
      renderer: renderer)


proc startServer*(self: Server) =
  self.logger.log(%*{"event": "@frame:server_start",
      "message": "Starting web server"})
  self.jester.serve() # blocks forever
