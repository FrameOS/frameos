# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.

import pixie
import assets
import asyncdispatch, jester
from net import Port
import options
from ./image import createImage

proc match(request: Request): ResponseData =
  block route:
    case request.pathInfo
    of "/":
      {.cast(gcsafe).}:
        resp Http200, assets.getAsset("assets/index.html")
    of "/image":
      let image = createImage(400, 400)
      resp Http200, {"Content-Type": "image/png"}, image.encodeImage(PngFormat)
    else:
      resp Http404, "Not found!"

proc initServer() =
  let port = 8787.Port # paramStr(1).parseInt().Port
  let settings = newSettings(port=port)
  var jester = initJester(matcher=match.MatchProcSync, settings=settings)
  jester.serve()
    
  echo("Hello, World!")

export initServer