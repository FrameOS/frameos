import pixie, json, strformat, strutils, tables
import lib/lgpio
import frameos/types
import frameos/channels

const debounce = 100000
const lineFlag = LG_SET_PULL_UP
const edge = LG_FALLING_EDGE

let pinLabels = newTable[int, string]()

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
  if frameOS.frameConfig.gpioButtons.len == 0:
    log("No buttons configured")
    return
  let gpioDevice = determineGPIODevice()

  let h = lgGpiochipOpen(gpioDevice.cint)
  result = Driver(name: "gpioButton", handler: h)
  if h < 0:
    log(&"gpiochip{gpioDevice} open failed")
    return

  for button in frameOS.frameConfig.gpioButtons:
    if button.pin < 0:
      log(&"Invalid GPIO pin {button.pin} ({button.label})")
      continue
    log(&"Listening on GPIO {button.pin} ({button.label})")
    pinLabels[button.pin] = button.label

    if lgGpioClaimInput(h, lineFlag.cint, button.pin.cint) < 0:
      log(&"Unable to claim GPIO {button.pin} for input")
      continue
    let res = lgGpioClaimAlert(h, 0, edge.cint, button.pin.cint, -1)
    if res < 0:
      log(&"Unable to claim GPIO {button.pin} for alerts: {lguErrorText(res)}")
      continue
    if lgGpioSetAlertsFunc(h, button.pin.cint, alertsHandler, nil) < 0:
      log(&"Unable to set alerts handler for GPIO {button.pin}")
      continue
    if lgGpioSetDebounce(h, button.pin.cint, debounce.cint) < 0:
      log(&"Unable to set debounce for GPIO {button.pin}")
      continue
