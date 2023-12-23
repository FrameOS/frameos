import json

from frameos/types import FrameOS, Server
from frameos/config import loadConfig
from frameos/logger import newLogger, log
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
  var message = %*{"event": "@frame:config", "config": {
    "framePort": self.config.framePort,
    "width": self.config.width,
    "height": self.config.height,
    "device": self.config.device,
    "color": self.config.color,
    "interval": self.config.interval,
    "metrics_interval": self.config.metricsInterval,
    "scaling_mode": self.config.scalingMode,
    "rotate": self.config.rotate,
    "background_color": self.config.backgroundColor,
  }}
  self.logger.log(message)
  self.server.startServer()

proc startFrameOS*() =
  var frameOS = newFrameOS()
  frameOS.start()
