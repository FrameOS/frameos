import pixie, json, strformat, strutils
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

  let pins = [5.cint, 6.cint, 16.cint, 24.cint]
  for pin in pins:
    if gpioHandler.registerButton(pin.cint).int == -1:
      log(frameOS.logger, &"Failed to register GPIO button {pin}")
