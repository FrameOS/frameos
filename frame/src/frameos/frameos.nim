import pixie
import os
from net import Port
from frameos/server import initServer
from frameos/config import loadConfig
from frameos/logger import newLogger, log
from frameos/render import render

let target = os.getenv("TARGET", "web")

proc startFrameOS() =
  let config = loadConfig()
  let logger = newLogger(config)
  initServer(config, logger) # blocks forever

proc renderOnce() =
  let image = render(loadConfig())
  let dir = "tmp"
  if not dirExists(dir):
    createDir(dir)
  image.writeFile("tmp/frame.png")

proc main*() =
  if target == "file":
    renderOnce()
  elif target == "web":
    startFrameOS() # blocks forever
  else:
    echo("Unknown target: " & target)
