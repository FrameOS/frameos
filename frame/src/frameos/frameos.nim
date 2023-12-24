import json

from frameos/types import FrameOS, Server
from frameos/config import loadConfig
from frameos/logger import newLogger, log
from frameos/server import newServer, startServer
from frameos/renderer import newRenderer

proc newFrameOS*(): FrameOS =
  var frameConfig = loadConfig()
  var logger = newLogger(frameConfig)
  var renderer = newRenderer(frameConfig, logger)
  var server = newServer(frameConfig, logger, renderer)
  result = FrameOS(
    frameConfig: frameConfig,
    logger: logger,
    renderer: renderer,
    server: server,
  )

proc start*(self: FrameOS) =
  var message = %*{"event": "@frame:config", "config": {
    "framePort": self.frameConfig.framePort,
    "width": self.frameConfig.width,
    "height": self.frameConfig.height,
    "device": self.frameConfig.device,
    "color": self.frameConfig.color,
    "interval": self.frameConfig.interval,
    "metrics_interval": self.frameConfig.metricsInterval,
    "scaling_mode": self.frameConfig.scalingMode,
    "rotate": self.frameConfig.rotate,
    "background_color": self.frameConfig.backgroundColor,
  }}
  self.logger.log(message)
  self.server.startServer()

proc startFrameOS*() =
  var frameOS = newFrameOS()
  frameOS.start()
