import pixie, json
import frameos/types

import gpioHandler/gpioHandler as gpioHandler

type Driver* = ref object of FrameOSDriver
  logger: Logger
  handler: int

proc log(logger: Logger, message: string) =
  logger.log(%*{"event": "driver:gpioButton", "log": message})

proc init*(frameOS: FrameOS): Driver =
  log(frameOS.logger, "Initializing GPIO button driver")

  let callback = proc (pin: cint, value: cint) =
    frameOS.logger.log(%*{"event": "gpio:press", "pin": $pin, "value": $value})

  let handler = gpioHandler.init(callback).int
  if handler == -1:
    log(frameOS.logger, "Failed to initialize GPIO button driver")

  result = Driver(
    name: "gpioButton",
    logger: frameOS.logger,
    handler: handler
  )

  let pins = [5, 6, 16, 24]
  for pin in pins:
    gpioHandler.registerButton(pin)
