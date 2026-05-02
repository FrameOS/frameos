## ***************************************************************************
##  | File        :   EPD_4in0e.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   4inch e-Paper (E) Driver
##  | Info        :   Native Nim implementation of the Waveshare driver
## ----------------
##  | This version:   V1.0
##  | Date        :   2024-08-20
##  | Info        :
##  -----------------------------------------------------------------------------
## #
## # Permission is hereby granted, free of charge, to any person obtaining a copy
## # of this software and associated documnetation files (the "Software"), to deal
## # in the Software without restriction, including without limitation the rights
## # to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
## # copies of the Software, and to permit persons to  whom the Software is
## # furished to do so, subject to the following conditions:
## #
## # The above copyright notice and this permission notice shall be included in
## # all copies or substantial portions of the Software.
## #
## # THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
## # IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
## # FITNESS OR FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
## # AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
## # LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
## # OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
## # THE SOFTWARE.
## #
## ****************************************************************************

import
  DEV_Config,
  json,
  options,
  strformat,
  strutils,
  times,
  std/monotimes

from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled
import frameos/utils/time

const
  EPD_4IN0E_WIDTH* = 400
  EPD_4IN0E_HEIGHT* = 600
  busyLogLoopInterval = 100
  busyLogMinIntervalMs = 1000.0

## ********************************
## Color Index
## ********************************

const
  EPD_4IN0E_BLACK* = 0x0
  EPD_4IN0E_WHITE* = 0x1
  EPD_4IN0E_YELLOW* = 0x2
  EPD_4IN0E_RED* = 0x3
  EPD_4IN0E_BLUE* = 0x5
  EPD_4IN0E_GREEN* = 0x6

type
  UByteArray = UncheckedArray[UBYTE]

var
  dataLogCounter = 0
  dataBytesCurrentCommand = 0

proc capturePinStates(): JsonNode =
  %*{
    "busy": DEV_Digital_Read(UWORD(EPD_BUSY_PIN)).int,
    "rst": DEV_Digital_Read(UWORD(EPD_RST_PIN)).int,
    "dc": DEV_Digital_Read(UWORD(EPD_DC_PIN)).int,
    "cs": DEV_Digital_Read(UWORD(EPD_CS_PIN)).int,
    "pwr": DEV_Digital_Read(UWORD(EPD_PWR_PIN)).int
  }

template logDebug(action: string, extra: JsonNode = nil) =
  if driverDebugLogsEnabled():
    var payload = %*{"event": "driver:waveshare:debug", "action": action}
    if extra != nil and extra.kind == JObject:
      for key, value in extra.pairs:
        payload[key] = value
    logDriverDebug(payload)

proc logCommand(reg: UBYTE) =
  dataLogCounter = 0
  dataBytesCurrentCommand = 0
  if driverDebugLogsEnabled():
    logDriverDebug(%*{
      "event": "driver:waveshare:command",
      "command": reg.int,
      "commandHex": &"0x{toHex(reg.int, 2)}"
    })

proc epd4in0eReset() =
  logDebug("reset:start")
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(0))
  DEV_Delay_ms(UDOUBLE(2))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))
  logDebug("reset:done")

proc epd4in0eSendCommand(reg: UBYTE) =
  logCommand(reg)
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(0))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(reg)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

proc epd4in0eSendData(data: UBYTE) =
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(1))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(data)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

  inc dataBytesCurrentCommand
  if driverDebugLogsEnabled():
    if dataLogCounter < 16:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "index": dataBytesCurrentCommand,
        "data": data.int,
        "dataHex": &"0x{toHex(data.int, 2)}"
      })
    elif dataLogCounter == 16:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "message": "Further data logging suppressed for this command",
        "bytesSent": dataBytesCurrentCommand
      })
    elif (dataBytesCurrentCommand mod 4096) == 0:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "message": "Data transfer progress",
        "bytesSent": dataBytesCurrentCommand
      })
    inc dataLogCounter

proc epd4in0eReadBusyH() =
  let startTime = getMonoTime()
  var loopCount = 0
  var lastLog = startTime
  let initialState = DEV_Digital_Read(UWORD(EPD_BUSY_PIN))
  logDebug("busy:wait:start", %*{
    "initialState": initialState.int,
    "pins": capturePinStates()
  })

  var observedLow = initialState == UBYTE(0)
  var lowStartTime = if observedLow: some(startTime) else: none(MonoTime)

  if (not observedLow) and DEV_Digital_Read(UWORD(EPD_BUSY_PIN)) == UBYTE(0):
    observedLow = true
    lowStartTime = some(getMonoTime())

  while DEV_Digital_Read(UWORD(EPD_BUSY_PIN)) == UBYTE(0):
    if not observedLow:
      observedLow = true
      lowStartTime = some(getMonoTime())

    DEV_Delay_ms(UDOUBLE(10))
    inc loopCount

    if driverDebugLogsEnabled() and loopCount mod busyLogLoopInterval == 0:
      let now = getMonoTime()
      if durationToMilliseconds(now - lastLog) >= busyLogMinIntervalMs:
        logDriverDebug(%*{
          "event": "driver:waveshare:busy",
          "loops": loopCount,
          "elapsedMs": durationToMilliseconds(now - startTime),
          "stage": "waitForHigh",
          "pins": capturePinStates()
        })
        lastLog = now

  DEV_Delay_ms(UDOUBLE(100))

  let endTime = getMonoTime()
  let durationMs = durationToMilliseconds(endTime - startTime)
  let finalState = DEV_Digital_Read(UWORD(EPD_BUSY_PIN))
  let finalPins = capturePinStates()

  let waitForLowMs =
    if observedLow and lowStartTime.isSome:
      durationToMilliseconds(lowStartTime.get() - startTime)
    else: 0.0
  let waitForHighMs =
    if observedLow and lowStartTime.isSome:
      durationToMilliseconds(endTime - lowStartTime.get())
    else: 0.0

  logDebug("busy:wait:end", %*{
    "durationMs": durationMs,
    "loops": loopCount,
    "finalState": finalState.int,
    "observedLow": observedLow,
    "waitedForLowMs": waitForLowMs,
    "waitedForHighMs": waitForHighMs,
    "timedOutWaitingForLow": false,
    "timedOutWaitingForHigh": false,
    "pins": finalPins
  })

proc epd4in0eTurnOnDisplay() =
  logDebug("turnOnDisplay:start")
  logDebug("turnOnDisplay:powerOn")
  epd4in0eSendCommand(0x04) # POWER_ON
  epd4in0eReadBusyH()
  DEV_Delay_ms(UDOUBLE(200))

  logDebug("turnOnDisplay:secondSetting")
  ## Second setting
  epd4in0eSendCommand(0x06)
  epd4in0eSendData(0x6F)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x17)
  epd4in0eSendData(0x27)
  DEV_Delay_ms(UDOUBLE(200))

  logDebug("turnOnDisplay:refresh")
  epd4in0eSendCommand(0x12) # DISPLAY_REFRESH
  epd4in0eSendData(0x00)
  epd4in0eReadBusyH()

  logDebug("turnOnDisplay:powerOff")
  epd4in0eSendCommand(0x02) # POWER_OFF
  epd4in0eSendData(0x00)
  epd4in0eReadBusyH()
  logDebug("turnOnDisplay:done")

proc EPD_4IN0E_Init*() =
  logDebug("init:start")
  epd4in0eReset()
  epd4in0eReadBusyH()
  DEV_Delay_ms(UDOUBLE(30))
  logDebug("init:afterResetDelay")

  logDebug("init:cmdh")
  epd4in0eSendCommand(0xAA)
  epd4in0eSendData(0x49)
  epd4in0eSendData(0x55)
  epd4in0eSendData(0x20)
  epd4in0eSendData(0x08)
  epd4in0eSendData(0x09)
  epd4in0eSendData(0x18)

  logDebug("init:drvPLL")
  epd4in0eSendCommand(0x01)
  epd4in0eSendData(0x3F)

  logDebug("init:powerSetting")
  epd4in0eSendCommand(0x00)
  epd4in0eSendData(0x5F)
  epd4in0eSendData(0x69)

  logDebug("init:powerOptimisation1")
  epd4in0eSendCommand(0x05)
  epd4in0eSendData(0x40)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x2C)

  logDebug("init:powerOptimisation2")
  epd4in0eSendCommand(0x08)
  epd4in0eSendData(0x6F)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x22)

  logDebug("init:powerOptimisation3")
  epd4in0eSendCommand(0x06)
  epd4in0eSendData(0x6F)
  epd4in0eSendData(0x1F)
  epd4in0eSendData(0x17)
  epd4in0eSendData(0x17)

  logDebug("init:boosterSoftStart")
  epd4in0eSendCommand(0x03)
  epd4in0eSendData(0x00)
  epd4in0eSendData(0x54)
  epd4in0eSendData(0x00)
  epd4in0eSendData(0x44)

  logDebug("init:tconSetting")
  epd4in0eSendCommand(0x60)
  epd4in0eSendData(0x02)
  epd4in0eSendData(0x00)

  logDebug("init:powerOptimisation4")
  epd4in0eSendCommand(0x30)
  epd4in0eSendData(0x08)

  logDebug("init:vcomAndDataInterval")
  epd4in0eSendCommand(0x50)
  epd4in0eSendData(0x3F)

  logDebug("init:resolution")
  epd4in0eSendCommand(0x61)
  epd4in0eSendData(0x01)
  epd4in0eSendData(0x90)
  epd4in0eSendData(0x02)
  epd4in0eSendData(0x58)

  logDebug("init:pllControl")
  epd4in0eSendCommand(0xE3)
  epd4in0eSendData(0x2F)

  logDebug("init:vdcsSetting")
  epd4in0eSendCommand(0x84)
  epd4in0eSendData(0x01)
  epd4in0eReadBusyH()
  logDebug("init:done")

proc EPD_4IN0E_Clear*(color: UBYTE) =
  let width =
    if (EPD_4IN0E_WIDTH and 1) == 0:
      EPD_4IN0E_WIDTH div 2
    else:
      EPD_4IN0E_WIDTH div 2 + 1
  let height = EPD_4IN0E_HEIGHT
  let totalBytes = width * height

  logDebug("clear:start", %*{"color": color.int, "widthBytes": width, "height": height, "totalBytes": totalBytes})

  epd4in0eSendCommand(0x10)
  for _ in 0 ..< height:
    for _ in 0 ..< width:
      let packed = (color shl 4) or color
      epd4in0eSendData(UBYTE(packed))

  logDebug("clear:dataWritten", %*{"totalBytes": totalBytes})
  epd4in0eTurnOnDisplay()

proc EPD_4IN0E_Show7Block*() =
  const colorSeven = [
    UBYTE(EPD_4IN0E_BLACK),
    UBYTE(EPD_4IN0E_YELLOW),
    UBYTE(EPD_4IN0E_RED),
    UBYTE(EPD_4IN0E_BLUE),
    UBYTE(EPD_4IN0E_GREEN),
    UBYTE(EPD_4IN0E_WHITE)
  ]

  logDebug("show7Block:start", %*{"blocks": colorSeven.len, "bytesPerBlock": 20000})
  epd4in0eSendCommand(0x10)
  for color in colorSeven:
    for _ in 0 ..< 20000:
      let packed = (color shl 4) or color
      epd4in0eSendData(UBYTE(packed))

  logDebug("show7Block:dataWritten", %*{"totalBytes": colorSeven.len * 20000})
  epd4in0eTurnOnDisplay()

proc EPD_4IN0E_Show*() =
  const colorSeven = [
    UBYTE(EPD_4IN0E_BLACK),
    UBYTE(EPD_4IN0E_YELLOW),
    UBYTE(EPD_4IN0E_RED),
    UBYTE(EPD_4IN0E_BLUE),
    UBYTE(EPD_4IN0E_GREEN),
    UBYTE(EPD_4IN0E_WHITE)
  ]

  let width =
    if (EPD_4IN0E_WIDTH and 1) == 0:
      EPD_4IN0E_WIDTH div 2
    else:
      EPD_4IN0E_WIDTH div 2 + 1
  let height = EPD_4IN0E_HEIGHT
  let totalBytes = width * height

  var k = 0
  var o = 0

  logDebug("show:start", %*{"widthBytes": width, "height": height, "totalBytes": totalBytes})
  epd4in0eSendCommand(0x10)
  for j in 0 ..< height:
    if (j > 10) and (j < 50):
      for _ in 0 ..< width:
        let color = colorSeven[0]
        let packed = (color shl 4) or color
        epd4in0eSendData(UBYTE(packed))
    elif o < height div 2:
      for _ in 0 ..< width:
        let color = colorSeven[0]
        let packed = (color shl 4) or color
        epd4in0eSendData(UBYTE(packed))
    else:
      for _ in 0 ..< width:
        let color = colorSeven[k]
        let packed = (color shl 4) or color
        epd4in0eSendData(UBYTE(packed))
      inc k
      if k >= colorSeven.len:
        k = 0

    inc o
    if o >= height:
      o = 0

  logDebug("show:dataWritten", %*{"totalBytes": totalBytes})
  epd4in0eTurnOnDisplay()

proc EPD_4IN0E_Display*(image: ptr UBYTE) =
  if image.isNil:
    logDebug("display:image:nil")
    return

  let width =
    if (EPD_4IN0E_WIDTH and 1) == 0:
      EPD_4IN0E_WIDTH div 2
    else:
      EPD_4IN0E_WIDTH div 2 + 1
  let height = EPD_4IN0E_HEIGHT
  let buffer = cast[ptr UByteArray](image)
  let totalBytes = width * height

  logDebug("display:start", %*{"widthBytes": width, "height": height, "totalBytes": totalBytes})

  if driverDebugLogsEnabled() and totalBytes > 0:
    let previewCount = min(totalBytes, 16)
    var preview = newSeq[int](previewCount)
    for i in 0 ..< previewCount:
      preview[i] = buffer[i].int
    logDriverDebug(%*{
      "event": "driver:waveshare:dataPreview", "count": previewCount,
      "bytes": preview
    })

  epd4in0eSendCommand(0x10)
  for j in 0 ..< height:
    for i in 0 ..< width:
      let idx = i + j * width
      epd4in0eSendData(buffer[idx])

  logDebug("display:dataWritten", %*{"totalBytes": totalBytes})
  epd4in0eTurnOnDisplay()

proc EPD_4IN0E_Sleep*() =
  logDebug("sleep:start")
  epd4in0eSendCommand(0x07) # DEEP_SLEEP
  epd4in0eSendData(0xA5)
  logDebug("sleep:done")
