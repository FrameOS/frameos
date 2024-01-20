import pixie, json, strformat, strutils, tables
import lib/lgpio
import frameos/types
import frameos/channels

# TODO: make this configurable in the UI
let inputPins = [
  # pin, line flags, edge, debounce
  (5, LG_SET_PULL_UP, LG_FALLING_EDGE, 100000),
  (6, LG_SET_PULL_UP, LG_FALLING_EDGE, 100000),
  (16, LG_SET_PULL_UP, LG_FALLING_EDGE, 100000),
  (24, LG_SET_PULL_UP, LG_FALLING_EDGE, 100000)
]
let pinLabels = {
  5: "A",
  6: "B",
  16: "C",
  24: "D"
}.toTable

type Driver* = ref object of FrameOSDriver
  handler: int

proc log(message: string) =
  log(%*{"event": "driver:gpioButton", "log": message})

proc alertsHandler(num_alerts: cint, alerts: lgGpioAlert_p, userdata: pointer) {.cdecl.} =
  let alerts = cast[ptr UncheckedArray[lgGpioAlert_t]](alerts)
  for i in 0 .. num_alerts - 1:
    let gpio = alerts[i].report.gpio.int
    let level = alerts[i].report.level.int
    let label = pinLabels.getOrDefault(gpio)
    sendEvent("button", %*{"pin": gpio, "label": label, "level": level})

proc determineGPIODevice(): int =
  try:
    if readFile("/proc/cpuinfo").find("Raspberry Pi 5") >= 0:
      return 4
  except:
    discard
  return 0

proc init*(frameOS: FrameOS): Driver =
  log("Initializing GPIO button driver")
  let gpioDevice = determineGPIODevice()

  let h = lgGpiochipOpen(gpioDevice.cint)
  result = Driver(name: "gpioButton", handler: h)
  if h < 0:
    log(&"gpiochip{gpioDevice} open failed")
    return

  for (pin, lineFlags, edge, debounce) in inputPins:
    log(&"Listening on GPIO {pin}")
    if lgGpioClaimInput(h, lineFlags.cint, pin.cint) < 0:
      log(&"Unable to claim GPIO {pin} for input")
      continue
    let res = lgGpioClaimAlert(h, 0, edge.cint, pin.cint, -1)
    if res < 0:
      log(&"Unable to claim GPIO {pin} for alerts: {lguErrorText(res)}")
      continue
    if lgGpioSetAlertsFunc(h, pin.cint, alertsHandler, nil) < 0:
      log(&"Unable to set alerts handler for GPIO {pin}")
      continue
    if lgGpioSetDebounce(h, pin.cint, debounce.cint) < 0:
      log(&"Unable to set debounce for GPIO {pin}")
      continue
