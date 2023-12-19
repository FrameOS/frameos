import pixie
import os
from net import Port
from ./image import createImage
from ./server import initServer

let target = os.getenv("TARGET", "file")
echo target

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
    initServer()
  else:
    echo("Unknown target: " & target)
    
  echo("Hello, World!")

when isMainModule:
  main()
