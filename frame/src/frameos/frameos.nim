from frameos/types import FrameOS, Server
from frameos/config import loadConfig
from frameos/logger import newLogger
from frameos/server import newServer, startServer
from frameos/renderer import newRenderer

proc newFrameOS*(): FrameOS =
  var config = loadConfig()
  var logger = newLogger(config)
  var renderer = newRenderer(config, logger)
  var server = newServer(config, logger, renderer)
  result = FrameOS(
    config: config,
    logger: logger,
    renderer: renderer,
    server: server,
  )

proc start*(self: FrameOS) =
  self.server.startServer()

proc startFrameOS*() =
  var frameOS = newFrameOS()
  frameOS.start()
