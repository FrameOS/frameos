# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.
import json
import pixie
import assets/web as webAssets
import asyncdispatch, jester
from net import Port
import options
from ./image import createImage
from ./config import Config
from ./logger import Logger, log

var globalLogger: Logger

proc match(request: Request): ResponseData =
  {.cast(gcsafe).}: # TODO: is this correct? https://forum.nim-lang.org/t/10474
    block route:
      case request.pathInfo
      of "/":
        resp Http200, webAssets.getAsset("assets/web/index.html")
      of "/image":
        let image = createImage(400, 400)
        globalLogger.log(%*{"event": "http", "path": "/image"})
        resp Http200, {"Content-Type": "image/png"}, image.encodeImage(PngFormat)
      else:
        resp Http404, "Not found!"

proc initServer(config: Config, logger: Logger) =
  globalLogger = logger
  let port = (config.framePort or 8787).Port
  let settings = newSettings(port = port)
  var jester = initJester(matcher = match.MatchProcSync, settings = settings)
  logger.log(%*{"event": "@frame:server_start",
      "message": "Starting web server on port " & $port.int})
  jester.serve()

export initServer
