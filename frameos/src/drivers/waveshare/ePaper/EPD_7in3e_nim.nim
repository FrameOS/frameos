## ***************************************************************************
##  | File        :   EPD_7in3e.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   7.3inch e-Paper (E) Driver
##  | Info        :   Native Nim implementation of the Waveshare driver
## ----------------
##  | This version:   V1.0
##  | Date        :   2022-10-20
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
## # FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
## # AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
## # LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
## # OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
## # THE SOFTWARE.
## #
## ****************************************************************************

import
  DEV_Config,
  json,
  strformat,
  strutils,
  times

from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled

const
  EPD_7IN3E_WIDTH* = 800
  EPD_7IN3E_HEIGHT* = 480

## ********************************
## Color Index
## ********************************

const
  EPD_7IN3E_BLACK* = 0x0
  EPD_7IN3E_WHITE* = 0x1
  EPD_7IN3E_YELLOW* = 0x2
  EPD_7IN3E_RED* = 0x3
  EPD_7IN3E_BLUE* = 0x5
  EPD_7IN3E_GREEN* = 0x6

type
  UByteArray = UncheckedArray[UBYTE]

var
  dataLogCounter = 0
  dataBytesCurrentCommand = 0

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

proc epd7in3eReset() =
  logDebug("reset:start")
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(0))
  DEV_Delay_ms(UDOUBLE(2))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))
  logDebug("reset:done")

proc epd7in3eSendCommand(reg: UBYTE) =
  logCommand(reg)
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(0))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(reg)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

proc epd7in3eSendData(data: UBYTE) =
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

const
  ## Maximum time (in milliseconds) we are willing to wait for the BUSY line to
  ## return high (idle) before reporting a timeout in the debug logs. This
  ## mirrors the behaviour of the reference C implementation which treats a
  ## high level as "ready" and a low level as "busy".
  busyWaitHighTimeoutMs = 60000.0

proc epd7in3eReadBusyH() =
  let startTime = epochTime()
  var loopCount = 0
  var lastLog = startTime
  var state = DEV_Digital_Read(UWORD(EPD_BUSY_PIN))
  let initialState = state
  logDebug("busy:wait:start", %*{"initialState": initialState.int})

  var observedLow = initialState == UBYTE(0)
  var waitForLowMs = 0.0
  var waitForHighMs = 0.0
  var timedOutWaitingForHigh = false

  if observedLow:
    let waitForHighStart = epochTime()
    while true:
      DEV_Delay_ms(UDOUBLE(1))
      inc loopCount

      if driverDebugLogsEnabled() and loopCount mod 500 == 0:
        let now = epochTime()
        if (now - lastLog) * 1000 >= 1000:
          logDriverDebug(%*{
            "event": "driver:waveshare:busy",
            "loops": loopCount,
            "elapsedMs": ((now - startTime) * 1000).int,
            "stage": "waitForHigh"
          })
          lastLog = now

      state = DEV_Digital_Read(UWORD(EPD_BUSY_PIN))
      if state == UBYTE(1):
        waitForHighMs = (epochTime() - waitForHighStart) * 1000
        break

      let elapsedHighMs = (epochTime() - waitForHighStart) * 1000
      if elapsedHighMs >= busyWaitHighTimeoutMs:
        timedOutWaitingForHigh = true
        waitForHighMs = elapsedHighMs
        break
  else:
    ## The BUSY line was already high when we entered the wait, mirroring the
    ## behaviour of the C implementation which treats this as "ready".
    state = UBYTE(1)

  if timedOutWaitingForHigh and driverDebugLogsEnabled():
    logDriverDebug(%*{
      "event": "driver:waveshare:busy",
      "stage": "waitForHighTimeout",
      "elapsedMs": waitForHighMs.int
    })

  let durationMs = (epochTime() - startTime) * 1000
  let finalState = state
  logDebug("busy:wait:end", %*{
    "durationMs": durationMs,
    "loops": loopCount,
    "finalState": finalState.int,
    "observedLow": observedLow,
    "waitedForLowMs": waitForLowMs,
    "waitedForHighMs": waitForHighMs,
    "timedOutWaitingForLow": false,
    "timedOutWaitingForHigh": timedOutWaitingForHigh
  })

proc epd7in3eTurnOnDisplay() =
  logDebug("turnOnDisplay:start")
  logDebug("turnOnDisplay:powerOn")
  epd7in3eSendCommand(0x04) # POWER_ON
  epd7in3eReadBusyH()

  logDebug("turnOnDisplay:secondSetting")
  ## Second setting
  epd7in3eSendCommand(0x06)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x17)
  epd7in3eSendData(0x49)

  logDebug("turnOnDisplay:refresh")
  epd7in3eSendCommand(0x12) # DISPLAY_REFRESH
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()

  logDebug("turnOnDisplay:powerOff")
  epd7in3eSendCommand(0x02) # POWER_OFF
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()
  logDebug("turnOnDisplay:done")

proc EPD_7IN3E_Init*() =
  logDebug("init:start")
  epd7in3eReset()
  epd7in3eReadBusyH()
  DEV_Delay_ms(UDOUBLE(30))
  logDebug("init:afterResetDelay")

  logDebug("init:cmdh")
  epd7in3eSendCommand(0xAA)
  epd7in3eSendData(0x49)
  epd7in3eSendData(0x55)
  epd7in3eSendData(0x20)
  epd7in3eSendData(0x08)
  epd7in3eSendData(0x09)
  epd7in3eSendData(0x18)

  logDebug("init:drvPLL")
  epd7in3eSendCommand(0x01)
  epd7in3eSendData(0x3F)

  logDebug("init:powerSetting")
  epd7in3eSendCommand(0x00)
  epd7in3eSendData(0x5F)
  epd7in3eSendData(0x69)

  logDebug("init:boosterSoftStart")
  epd7in3eSendCommand(0x03)
  epd7in3eSendData(0x00)
  epd7in3eSendData(0x54)
  epd7in3eSendData(0x00)
  epd7in3eSendData(0x44)

  logDebug("init:powerOptimisation1")
  epd7in3eSendCommand(0x05)
  epd7in3eSendData(0x40)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x2C)

  logDebug("init:powerOptimisation2")
  epd7in3eSendCommand(0x06)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x17)
  epd7in3eSendData(0x49)

  logDebug("init:powerOptimisation3")
  epd7in3eSendCommand(0x08)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x22)

  logDebug("init:powerOptimisation4")
  epd7in3eSendCommand(0x30)
  epd7in3eSendData(0x03)

  logDebug("init:vcomAndDataInterval")
  epd7in3eSendCommand(0x50)
  epd7in3eSendData(0x3F)

  logDebug("init:resolution")
  epd7in3eSendCommand(0x60)
  epd7in3eSendData(0x02)
  epd7in3eSendData(0x00)

  epd7in3eSendCommand(0x61)
  epd7in3eSendData(0x03)
  epd7in3eSendData(0x20)
  epd7in3eSendData(0x01)
  epd7in3eSendData(0xE0)

  logDebug("init:vdcsSetting")
  epd7in3eSendCommand(0x84)
  epd7in3eSendData(0x01)

  logDebug("init:pllControl")
  epd7in3eSendCommand(0xE3)
  epd7in3eSendData(0x2F)

  logDebug("init:powerOn")
  epd7in3eSendCommand(0x04)
  epd7in3eReadBusyH()
  logDebug("init:done")

proc EPD_7IN3E_Init_Fast*() =
  ## No dedicated fast initialisation sequence is available in the original
  ## driver, so we fall back to the standard initialisation routine.
  logDebug("initFast:delegated")
  EPD_7IN3E_Init()

proc EPD_7IN3E_Clear*(color: UBYTE) =
  let width =
    if (EPD_7IN3E_WIDTH and 1) == 0:
      EPD_7IN3E_WIDTH div 2
    else:
      EPD_7IN3E_WIDTH div 2 + 1
  let height = EPD_7IN3E_HEIGHT
  let totalBytes = width * height

  logDebug("clear:start", %*{"color": color.int, "widthBytes": width, "height": height, "totalBytes": totalBytes})

  epd7in3eSendCommand(0x10)
  for _ in 0 ..< height:
    for _ in 0 ..< width:
      let packed = (color shl 4) or color
      epd7in3eSendData(UBYTE(packed))

  logDebug("clear:dataWritten", %*{"totalBytes": totalBytes})
  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Show7Block*() =
  const colorSeven = [
    UBYTE(EPD_7IN3E_BLACK),
    UBYTE(EPD_7IN3E_YELLOW),
    UBYTE(EPD_7IN3E_RED),
    UBYTE(EPD_7IN3E_BLUE),
    UBYTE(EPD_7IN3E_GREEN),
    UBYTE(EPD_7IN3E_WHITE)
  ]

  logDebug("show7Block:start", %*{"blocks": colorSeven.len, "bytesPerBlock": 20000})
  epd7in3eSendCommand(0x10)
  for color in colorSeven:
    for _ in 0 ..< 20000:
      let packed = (color shl 4) or color
      epd7in3eSendData(UBYTE(packed))

  logDebug("show7Block:dataWritten", %*{"totalBytes": colorSeven.len * 20000})
  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Show*() =
  const colorSeven = [
    UBYTE(EPD_7IN3E_BLACK),
    UBYTE(EPD_7IN3E_YELLOW),
    UBYTE(EPD_7IN3E_RED),
    UBYTE(EPD_7IN3E_BLUE),
    UBYTE(EPD_7IN3E_GREEN),
    UBYTE(EPD_7IN3E_WHITE)
  ]

  let width =
    if (EPD_7IN3E_WIDTH and 1) == 0:
      EPD_7IN3E_WIDTH div 2
    else:
      EPD_7IN3E_WIDTH div 2 + 1
  let height = EPD_7IN3E_HEIGHT
  let totalBytes = width * height

  var k = 0
  var o = 0

  logDebug("show:start", %*{"widthBytes": width, "height": height, "totalBytes": totalBytes})
  epd7in3eSendCommand(0x10)
  for j in 0 ..< height:
    if (j > 10) and (j < 50):
      for _ in 0 ..< width:
        let color = colorSeven[0]
        let packed = (color shl 4) or color
        epd7in3eSendData(UBYTE(packed))
    elif o < height div 2:
      for _ in 0 ..< width:
        let color = colorSeven[0]
        let packed = (color shl 4) or color
        epd7in3eSendData(UBYTE(packed))
    else:
      for _ in 0 ..< width:
        let color = colorSeven[k]
        let packed = (color shl 4) or color
        epd7in3eSendData(UBYTE(packed))
      inc k
      if k >= colorSeven.len:
        k = 0

    inc o
    if o >= height:
      o = 0

  logDebug("show:dataWritten", %*{"totalBytes": totalBytes})
  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Display*(image: ptr UBYTE) =
  if image.isNil:
    logDebug("display:image:nil")
    return

  let width =
    if (EPD_7IN3E_WIDTH and 1) == 0:
      EPD_7IN3E_WIDTH div 2
    else:
      EPD_7IN3E_WIDTH div 2 + 1
  let height = EPD_7IN3E_HEIGHT
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

  epd7in3eSendCommand(0x10)
  for j in 0 ..< height:
    for i in 0 ..< width:
      let idx = i + j * width
      epd7in3eSendData(buffer[idx])

  logDebug("display:dataWritten", %*{"totalBytes": totalBytes})
  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Sleep*() =
  logDebug("sleep:start")
  epd7in3eSendCommand(0x02)
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()

  epd7in3eSendCommand(0x07)
  epd7in3eSendData(0xA5)
  logDebug("sleep:done")
