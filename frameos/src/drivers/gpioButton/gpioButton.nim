import pixie, json, strformat, strutils
import frameos/types
import frameos/channels

import ../gpioHandler/gpioHandler as gpioHandler

type Driver* = ref object of FrameOSDriver
  logger: Logger
  handler: int

proc log(message: string) =
  log(%*{"event": "driver:gpioButton", "log": message})

proc init*(frameOS: FrameOS): Driver =
  log("Initializing GPIO button driver")

  let eventCallback = proc (pin: cint, value: cint) {.cdecl.} =
    log(%*{"event": "gpio:press", "pin": pin.int, "value": value.int})

  let logCallback = proc (message: cstring) {.cdecl.} =
    log($message)

  let handler = gpioHandler.init(eventCallback, logCallback).int
  if handler == -1:
    log("Failed to initialize GPIO button driver")

  result = Driver(
    name: "gpioButton",
    logger: frameOS.logger,
    handler: handler
  )

  let pins = [5.cint, 6.cint, 16.cint, 24.cint]
  for pin in pins:
    log(&"Listening on GPIO {pin}")
    if gpioHandler.registerButton(pin.cint).int == -1:
      log(&"Failed to register GPIO button {pin}")
