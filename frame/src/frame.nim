import pixie
import os
from net import Port
from ./image import createImage
from ./server import initServer
from ./config import loadConfig

let target = os.getenv("TARGET", "file")
echo target

proc main() =
  let config = loadConfig()
  let width = config.width
  let height = config.height
  if target == "file":
    let image = createImage(width, height)
    let dir = "tmp"
    if not dirExists(dir):
      createDir(dir)
    image.writeFile("tmp/text_spans.png")
  elif target == "web":
    initServer()
  else:
    echo("Unknown target: " & target)

  echo("Hello, World!")

when isMainModule:
  main()
