import json, strformat, strutils
import std/monotimes

import lib/lgpio
import frameos/utils/time
from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled

const
  Cs0* = 0b01
  Cs1* = 0b10
  CsBoth* = Cs0 or Cs1
  SpiChunkSize = 4096

type
  UBYTE* = uint8

  InkyPins* = object
    reset*: int
    busy*: int
    dc*: int
    cs0*: int
    cs1*: int
    hasCs1*: bool
    spiBaud*: int
    spiChannel*: int

var
  gpioHandle = cint(-1)
  spiHandle = cint(-1)
  activePins*: InkyPins
  moduleReady = false

proc logDebug(action: string, extra: JsonNode = nil) =
  if driverDebugLogsEnabled():
    var payload = %*{"event": "driver:inky:debug", "action": action}
    if extra != nil and extra.kind == JObject:
      for key, value in extra.pairs:
        payload[key] = value
    logDriverDebug(payload)

proc determineGpioChip(): cint =
  try:
    if readFile("/proc/cpuinfo").contains("Raspberry Pi 5"):
      return 4
  except CatchableError:
    discard
  0

proc close*() =
  if spiHandle >= 0:
    discard lgSpiClose(spiHandle)
    spiHandle = cint(-1)
  if gpioHandle >= 0:
    discard lgGpiochipClose(gpioHandle)
    gpioHandle = cint(-1)
  moduleReady = false

proc claimOutput(pin: int; level: int) =
  let res = lgGpioClaimOutput(gpioHandle, 0, pin.cint, level.cint)
  if res < 0:
    raise newException(OSError, &"Unable to claim GPIO {pin} for output: {$lguErrorText(res)}")

proc claimInput(pin: int) =
  let res = lgGpioClaimInput(gpioHandle, LG_SET_PULL_UP.cint, pin.cint)
  if res < 0:
    raise newException(OSError, &"Unable to claim GPIO {pin} for input: {$lguErrorText(res)}")

proc init*(pins: InkyPins): bool =
  if moduleReady:
    return true

  activePins = pins
  let gpioChip = determineGpioChip()
  gpioHandle = lgGpiochipOpen(gpioChip)
  if gpioHandle < 0:
    logDebug("moduleInit:gpio:error", %*{"gpiochip": gpioChip, "error": $lguErrorText(gpioHandle)})
    return false

  spiHandle = lgSpiOpen(0, pins.spiChannel.cint, pins.spiBaud.cint, 0)
  if spiHandle < 0:
    logDebug("moduleInit:spi:error", %*{"bus": 0, "channel": pins.spiChannel, "error": $lguErrorText(spiHandle)})
    close()
    return false

  try:
    claimOutput(pins.cs0, LG_HIGH)
    if pins.hasCs1:
      claimOutput(pins.cs1, LG_HIGH)
    claimOutput(pins.dc, LG_LOW)
    claimOutput(pins.reset, LG_HIGH)
    claimInput(pins.busy)
  except Exception as e:
    logDebug("moduleInit:claim:error", %*{"error": e.msg})
    close()
    return false

  moduleReady = true
  logDebug("moduleInit:done", %*{
    "gpiochip": gpioChip,
    "spiBaud": pins.spiBaud,
    "spiChannel": pins.spiChannel,
    "reset": pins.reset,
    "busy": pins.busy,
    "dc": pins.dc,
    "cs0": pins.cs0,
    "cs1": pins.cs1,
    "hasCs1": pins.hasCs1,
  })
  true

proc delayMs*(milliseconds: int) =
  if milliseconds <= 0:
    return
  lguSleep(milliseconds.float / 1000.0)

proc writePin*(pin: int; value: int) =
  discard lgGpioWrite(gpioHandle, pin.cint, value.cint)

proc readPin*(pin: int): int =
  let value = lgGpioRead(gpioHandle, pin.cint)
  if value <= 0: 0 else: value.int

proc reset*(lowMs, highMs: int; doublePulse = false) =
  logDebug("reset:start")
  writePin(activePins.reset, LG_LOW)
  delayMs(lowMs)
  writePin(activePins.reset, LG_HIGH)
  delayMs(highMs)
  if doublePulse:
    writePin(activePins.reset, LG_LOW)
    delayMs(lowMs)
    writePin(activePins.reset, LG_HIGH)
    delayMs(highMs)
  logDebug("reset:done")

proc selectCs(csSel: int; level: int) =
  if (csSel and Cs0) != 0:
    writePin(activePins.cs0, level)
  if activePins.hasCs1 and (csSel and Cs1) != 0:
    writePin(activePins.cs1, level)

proc deselectAllCs*() =
  writePin(activePins.cs0, LG_HIGH)
  if activePins.hasCs1:
    writePin(activePins.cs1, LG_HIGH)

proc spiWriteByte(value: uint8) =
  var data = value
  discard lgSpiWrite(spiHandle, cast[cstring](addr data), 1)

proc spiWrite*(data: openArray[uint8]) =
  if data.len == 0:
    return

  var offset = 0
  while offset < data.len:
    let count = min(SpiChunkSize, data.len - offset)
    discard lgSpiWrite(spiHandle, cast[cstring](unsafeAddr data[offset]), count.cint)
    offset += count

proc sendCommand*(command: uint8; data: openArray[uint8]; csSel: int = Cs0; commandDelayMs: int = 0) =
  logDebug("command", %*{"command": command.int, "commandHex": &"0x{toHex(command.int, 2)}", "dataBytes": data.len, "csSel": csSel})
  selectCs(csSel, LG_LOW)
  writePin(activePins.dc, LG_LOW)
  delayMs(commandDelayMs)
  spiWriteByte(command)

  if data.len > 0:
    writePin(activePins.dc, LG_HIGH)
    spiWrite(data)

  deselectAllCs()
  writePin(activePins.dc, LG_LOW)

proc sendCommand*(command: uint8; csSel: int = Cs0; commandDelayMs: int = 0) =
  let empty: array[0, uint8] = []
  sendCommand(command, empty, csSel, commandDelayMs)

proc busyWaitHigh*(timeoutMs: int; pollMs: int = 10) =
  let startTime = getMonoTime()
  let initialState = readPin(activePins.busy)
  logDebug("busy:wait:start", %*{"initialState": initialState, "timeoutMs": timeoutMs})

  if initialState > 0:
    logDebug("busy:heldHigh", %*{"timeoutMs": timeoutMs})
    delayMs(timeoutMs)
    return

  var loops = 0
  while readPin(activePins.busy) == 0:
    delayMs(pollMs)
    inc loops
    let elapsed = durationToMilliseconds(getMonoTime() - startTime)
    if elapsed >= timeoutMs.float:
      logDebug("busy:timeout", %*{"elapsedMs": elapsed, "loops": loops})
      return

  logDebug("busy:wait:end", %*{
    "elapsedMs": durationToMilliseconds(getMonoTime() - startTime),
    "loops": loops,
    "finalState": readPin(activePins.busy),
  })

proc busyWaitLow*(timeoutMs: int; pollMs: int = 10) =
  let startTime = getMonoTime()
  let initialState = readPin(activePins.busy)
  logDebug("busy:waitLow:start", %*{"initialState": initialState, "timeoutMs": timeoutMs})

  var loops = 0
  while readPin(activePins.busy) != 0:
    delayMs(pollMs)
    inc loops
    let elapsed = durationToMilliseconds(getMonoTime() - startTime)
    if elapsed >= timeoutMs.float:
      logDebug("busy:waitLow:timeout", %*{"elapsedMs": elapsed, "loops": loops})
      return

  logDebug("busy:waitLow:end", %*{
    "elapsedMs": durationToMilliseconds(getMonoTime() - startTime),
    "loops": loops,
    "finalState": readPin(activePins.busy),
  })
