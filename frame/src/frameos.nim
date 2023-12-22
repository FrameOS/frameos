import pixie
import os
from net import Port
from ./image import createImage
from ./server import initServer
from ./config import loadConfig
from ./logger import newLogger, log

let target = os.getenv("TARGET", "web")
echo target

proc startFrameOS() =
  let config = loadConfig()
  let logger = newLogger(config)
  initServer(config, logger)

proc renderOnce() =
  let config = loadConfig()
  let width = config.width
  let height = config.height
  let image = createImage(width, height)
  let dir = "tmp"
  if not dirExists(dir):
    createDir(dir)
  image.writeFile("tmp/frame.png")


proc main() =
  if target == "file":
    renderOnce()
  elif target == "web":
    startFrameOS()
  else:
    echo("Unknown target: " & target)

  echo("Hello, World!")

when isMainModule:
  main()
