import osproc, os, streams, pixie, json, options

from frameos/types import FrameConfig, FrameOS, Logger, FrameOSDriver

type Driver* = ref object of FrameOSDriver
  logger: Logger

proc log(logger: Logger, message: string): JsonNode =
  try:
    result = parseJson(message)
    result["event"] = %*("driver:gpioButton")
  except:
    result = %*{"event": "driver:gpioButton", "log": message}
  logger.log(result)

proc init*(frameOS: FrameOS): Driver =
  discard frameOS.logger.log("Initializing GPIO button driver")

  result = Driver(
    name: "gpioButton",
    logger: frameOS.logger
  )

