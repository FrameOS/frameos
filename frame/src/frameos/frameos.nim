from frameos/types import FrameOS, Server
from frameos/config import loadConfig
from frameos/logger import newLogger
from frameos/server import newServer, startServer

proc newFrameOS*(): FrameOS =
  var config = loadConfig()
  var logger = newLogger(config)
  var server: Server = newServer(config, logger)
  result = FrameOS(
    config: config,
    logger: logger,
    server: server,
  )

proc start*(self: FrameOS) =
  self.server.startServer()

proc startFrameOS*() =
  var frameOS = newFrameOS()
  frameOS.start()
