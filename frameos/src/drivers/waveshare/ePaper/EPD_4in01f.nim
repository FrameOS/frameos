## ***************************************************************************
##  | File        :   EPD_4in01f.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   4.01inch e-paper
##  | Info        :   Native Nim implementation of the Waveshare driver
## ----------------
##  | This version:   V1.0
##  | Date        :   2020-11-06
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

## ********************************
## Color Index
## ********************************

const
  EPD_4IN01F_BLACK* = 0x0
  EPD_4IN01F_WHITE* = 0x1
  EPD_4IN01F_GREEN* = 0x2
  EPD_4IN01F_BLUE* = 0x3
  EPD_4IN01F_RED* = 0x4
  EPD_4IN01F_YELLOW* = 0x5
  EPD_4IN01F_ORANGE* = 0x6
  EPD_4IN01F_CLEAN* = 0x7
  EPD_4IN01F_WIDTH* = 640
  EPD_4IN01F_HEIGHT* = 400
  busyLogLoopInterval = 20
  busyLogMinIntervalMs = 1000.0
  # A full refresh takes ~30s; anything past this means a wedged controller
  # or a loose ribbon cable. Give up instead of hanging the render thread
  # forever.
  busyWaitTimeoutMs = 120_000.0

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

proc epd4in01fReset() =
  logDebug("reset:start")
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(200))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(0))
  DEV_Delay_ms(UDOUBLE(2))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(200))
  logDebug("reset:done")

proc epd4in01fSendCommand(reg: UBYTE) =
  logCommand(reg)
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(0))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(reg)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

proc epd4in01fSendData(data: UBYTE) =
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

proc epd4in01fWaitBusy(action: string, busyState: UBYTE, stage: string) =
  let startTime = getMonoTime()
  var loopCount = 0
  var lastLog = startTime
  let initialState = DEV_Digital_Read(UWORD(EPD_BUSY_PIN))
  logDebug(&"{action}:start", %*{
    "initialState": initialState.int,
    "busyState": busyState.int,
    "pins": capturePinStates()
  })

  var timedOut = false
  while DEV_Digital_Read(UWORD(EPD_BUSY_PIN)) == busyState:
    if durationToMilliseconds(getMonoTime() - startTime) >= busyWaitTimeoutMs:
      timedOut = true
      break
    DEV_Delay_ms(UDOUBLE(50))
    inc loopCount

    if driverDebugLogsEnabled() and loopCount mod busyLogLoopInterval == 0:
      let now = getMonoTime()
      if durationToMilliseconds(now - lastLog) >= busyLogMinIntervalMs:
        logDriverDebug(%*{
          "event": "driver:waveshare:busy",
          "loops": loopCount,
          "elapsedMs": durationToMilliseconds(now - startTime),
          "stage": stage,
          "pins": capturePinStates()
        })
        lastLog = now

  let endTime = getMonoTime()
  logDebug(&"{action}:end", %*{
    "durationMs": durationToMilliseconds(endTime - startTime),
    "loops": loopCount,
    "finalState": DEV_Digital_Read(UWORD(EPD_BUSY_PIN)).int,
    "busyState": busyState.int,
    "timedOut": timedOut,
    "pins": capturePinStates()
  })

proc epd4in01fBusyHigh() =
  ## If BUSYN = 0 then waiting.
  epd4in01fWaitBusy("busyHigh", UBYTE(0), "waitForHigh")

proc epd4in01fBusyLow() =
  ## If BUSYN = 1 then waiting.
  epd4in01fWaitBusy("busyLow", UBYTE(1), "waitForLow")

proc epd4in01fSetResolution() =
  epd4in01fSendCommand(0x61)
  epd4in01fSendData(0x02)
  epd4in01fSendData(0x80)
  epd4in01fSendData(0x01)
  epd4in01fSendData(0x90)

proc epd4in01fRefresh() =
  logDebug("refresh:powerOn")
  epd4in01fSendCommand(0x04)
  epd4in01fBusyHigh()

  logDebug("refresh:display")
  epd4in01fSendCommand(0x12)
  epd4in01fBusyHigh()

  logDebug("refresh:powerOff")
  epd4in01fSendCommand(0x02)
  epd4in01fBusyLow()
  logDebug("refresh:done")

proc EPD_4IN01F_Clear*(color: UBYTE) =
  let width = EPD_4IN01F_WIDTH div 2
  let height = EPD_4IN01F_HEIGHT
  let totalBytes = width * height

  logDebug("clear:start", %*{"color": color.int, "widthBytes": width, "height": height, "totalBytes": totalBytes})

  epd4in01fSetResolution()
  epd4in01fSendCommand(0x10)
  for _ in 0 ..< height:
    for _ in 0 ..< width:
      epd4in01fSendData(UBYTE((color shl 4) or color))

  DEV_Delay_ms(UDOUBLE(500))
  logDebug("clear:dataWritten", %*{"totalBytes": totalBytes})
  epd4in01fRefresh()

proc EPD_4IN01F_ReClear*() =
  let width = EPD_4IN01F_WIDTH div 2
  let height = EPD_4IN01F_HEIGHT
  let totalBytes = width * height

  logDebug("reclear:start", %*{"widthBytes": width, "height": height, "totalBytes": totalBytes})

  epd4in01fSetResolution()
  epd4in01fSendCommand(0x10)
  for _ in 0 ..< height:
    for _ in 0 ..< width:
      epd4in01fSendData(0x77)

  DEV_Delay_ms(UDOUBLE(500))
  logDebug("reclear:dataWritten", %*{"totalBytes": totalBytes})
  epd4in01fRefresh()

proc EPD_4IN01F_Sleep*() =
  logDebug("sleep:start")
  epd4in01fSendCommand(0x07)
  epd4in01fSendData(0xA5)
  logDebug("sleep:done")

proc EPD_4IN01F_Show7Block*() =
  const colorSeven = [
    UBYTE(EPD_4IN01F_BLACK),
    UBYTE(EPD_4IN01F_BLUE),
    UBYTE(EPD_4IN01F_GREEN),
    UBYTE(EPD_4IN01F_ORANGE),
    UBYTE(EPD_4IN01F_RED),
    UBYTE(EPD_4IN01F_YELLOW),
    UBYTE(EPD_4IN01F_WHITE),
    UBYTE(EPD_4IN01F_WHITE)
  ]

  logDebug("show7Block:start", %*{"blocks": colorSeven.len, "bytesPerStripe": EPD_4IN01F_WIDTH div 8})

  epd4in01fSetResolution()
  epd4in01fSendCommand(0x10)
  for _ in 0 ..< EPD_4IN01F_HEIGHT div 2:
    for k in 0 ..< 4:
      for _ in 0 ..< EPD_4IN01F_WIDTH div 8:
        let color = colorSeven[k]
        epd4in01fSendData(UBYTE((color shl 4) or color))

  for _ in 0 ..< EPD_4IN01F_HEIGHT div 2:
    for k in 4 ..< 8:
      for _ in 0 ..< EPD_4IN01F_WIDTH div 8:
        let color = colorSeven[k]
        epd4in01fSendData(UBYTE((color shl 4) or color))

  logDebug("show7Block:dataWritten", %*{"totalBytes": (EPD_4IN01F_WIDTH div 2) * EPD_4IN01F_HEIGHT})
  epd4in01fRefresh()

proc EPD_4IN01F_Display*(image: ptr UBYTE) =
  if image.isNil:
    logDebug("display:image:nil")
    return

  let width = EPD_4IN01F_WIDTH div 2
  let height = EPD_4IN01F_HEIGHT
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

  epd4in01fSetResolution()
  epd4in01fSendCommand(0x10)
  for i in 0 ..< height:
    for j in 0 ..< width:
      epd4in01fSendData(buffer[j + width * i])

  logDebug("display:dataWritten", %*{"totalBytes": totalBytes})
  epd4in01fRefresh()

proc EPD_4IN01F_Init*() =
  logDebug("init:start")
  epd4in01fReset()
  epd4in01fBusyHigh()

  logDebug("init:panelSetting")
  epd4in01fSendCommand(0x00)
  epd4in01fSendData(0x2F)
  epd4in01fSendData(0x00)

  logDebug("init:powerSetting")
  epd4in01fSendCommand(0x01)
  epd4in01fSendData(0x37)
  epd4in01fSendData(0x00)
  epd4in01fSendData(0x05)
  epd4in01fSendData(0x05)

  logDebug("init:powerOffSequence")
  epd4in01fSendCommand(0x03)
  epd4in01fSendData(0x00)

  logDebug("init:boosterSoftStart")
  epd4in01fSendCommand(0x06)
  epd4in01fSendData(0xC7)
  epd4in01fSendData(0xC7)
  epd4in01fSendData(0x1D)

  logDebug("init:temperatureSensor")
  epd4in01fSendCommand(0x41)
  epd4in01fSendData(0x00)

  logDebug("init:vcomAndDataInterval")
  epd4in01fSendCommand(0x50)
  epd4in01fSendData(0x37)

  logDebug("init:tconSetting")
  epd4in01fSendCommand(0x60)
  epd4in01fSendData(0x22)

  logDebug("init:resolution")
  epd4in01fSetResolution()

  logDebug("init:powerSaving")
  epd4in01fSendCommand(0xE3)
  epd4in01fSendData(0xAA)
  logDebug("init:done")

proc EPD_Init*() =
  EPD_4IN01F_Init()

proc EPD_4IN01F_Display_part*(
    image: ptr UBYTE;
    xstart: UWORD;
    ystart: UWORD;
    image_width: UWORD;
    image_heigh: UWORD
  ) =
  if image.isNil:
    logDebug("displayPart:image:nil")
    return

  let
    buffer = cast[ptr UByteArray](image)
    xStartByte = xstart.int div 2
    yStart = ystart.int
    partWidth = image_width.int
    partWidthBytes = partWidth div 2
    partHeight = image_heigh.int
    widthBytes = EPD_4IN01F_WIDTH div 2
    totalBytes = widthBytes * EPD_4IN01F_HEIGHT

  logDebug("displayPart:start", %*{
    "xstart": xstart.int,
    "ystart": ystart.int,
    "imageWidth": image_width.int,
    "imageHeight": image_heigh.int,
    "totalBytes": totalBytes
  })

  epd4in01fSetResolution()
  epd4in01fSendCommand(0x10)
  for i in 0 ..< EPD_4IN01F_HEIGHT:
    for j in 0 ..< widthBytes:
      if i < partHeight + yStart and i >= yStart and
          j < (partWidth + xstart.int) div 2 and j >= xStartByte:
        epd4in01fSendData(buffer[(j - xStartByte) + partWidthBytes * (i - yStart)])
      else:
        epd4in01fSendData(0x11)

  logDebug("displayPart:dataWritten", %*{"totalBytes": totalBytes})
  epd4in01fRefresh()
