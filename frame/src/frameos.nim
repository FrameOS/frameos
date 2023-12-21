import pixie
import os
import json
from net import Port
from ./image import createImage
from ./server import initServer
from ./config import loadConfig
from ./logger import newLogger, log

let target = os.getenv("TARGET", "web")
echo target

proc main() =
  let config = loadConfig()
  let logger = newLogger(config)
  logger.log(%*{"event": "bootstrap", "message": "Hello, World!"})

  let width = config.width
  let height = config.height

  if target == "file":
    let image = createImage(width, height)
    let dir = "tmp"
    if not dirExists(dir):
      createDir(dir)
    image.writeFile("tmp/text_spans.png")
  elif target == "web":
    initServer(config, logger)
  else:
    echo("Unknown target: " & target)

  echo("Hello, World!")

when isMainModule:
  main()
