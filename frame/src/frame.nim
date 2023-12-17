# This is just an example to get you started. A typical binary package
# uses this file as the main entry point of the application.

import pixie
import os
import assets
import asyncdispatch, jester, strutils
from net import Port
import options

# get the  env variable "PIXIE_HOME"
let target = os.getenv("TARGET", "file")
echo target

proc createImage(width, height: int): Image =
  let image = newImage(width, height)
  let typeface = readTypeface("fonts/Ubuntu-Regular_1.ttf")

  proc newFont(typeface: Typeface, size: float32, color: Color): Font =
    result = newFont(typeface)
    result.size = size
    result.paint.color = color

  let spans = @[
    newSpan("verb [with object] ",
      newFont(typeface, 12, color(0.78125, 0.78125, 0.78125, 1))),
    newSpan("strallow\n", newFont(typeface, 36, color(0, 0, 0, 1))),
    newSpan("\nstral·low\n", newFont(typeface, 13, color(0, 0.5, 0.953125, 1))),
    newSpan("\n1. free (something) from restrictive restrictions \"the regulations are intended to strallow changes in public policy\" ",
        newFont(typeface, 14, color(0.3125, 0.3125, 0.3125, 1)))
  ]

  image.fillText(typeset(spans, vec2(180, 180)), translate(vec2(10, 10)))
  return image

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

proc main() =
  let width = 400
  let height = 400
  if target == "file":
    let image = createImage(width, height)
    let dir = "tmp"
    if not dirExists(dir):
      createDir(dir)
    image.writeFile("tmp/text_spans.png")
  elif target == "web":
    let port = 8787.Port # paramStr(1).parseInt().Port
    let settings = newSettings(port=port)
    var jester = initJester(matcher=match.MatchProcSync, settings=settings)
    jester.serve()
  else:
    echo("Unknown target: " & target)
    
  echo("Hello, World!")

when isMainModule:
  main()
