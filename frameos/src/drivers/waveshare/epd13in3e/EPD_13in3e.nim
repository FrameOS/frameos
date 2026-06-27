## ***************************************************************************
##  | File        :   EPD_13in3e.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   13.3inch e-Paper (E) Driver
##  | Info        :   Native Nim implementation of the Waveshare driver
## ----------------
##  | This version:   V1.0
##  | Date        :   2018-11-29
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
  strformat,
  strutils,
  times,
  std/monotimes

from drivers/waveshare/types import logDriverDebug, driverDebugLogsEnabled
import frameos/utils/time

const
  EPD_13IN3E_WIDTH* = 1200
  EPD_13IN3E_HEIGHT* = 1600
  EPD_13IN3E_BLACK* = 0x0
  EPD_13IN3E_WHITE* = 0x1
  EPD_13IN3E_YELLOW* = 0x2
  EPD_13IN3E_RED* = 0x3
  EPD_13IN3E_BLUE* = 0x5
  EPD_13IN3E_GREEN* = 0x6

  PSR* = UBYTE(0x00)
  PWR* = UBYTE(0x01)
  POF* = UBYTE(0x02)
  PON* = UBYTE(0x04)
  BTST_N* = UBYTE(0x05)
  BTST_P* = UBYTE(0x06)
  DTM* = UBYTE(0x10)
  DRF* = UBYTE(0x12)
  CDI* = UBYTE(0x50)
  TCON* = UBYTE(0x60)
  TRES* = UBYTE(0x61)
  AN_TM* = UBYTE(0x74)
  AGID* = UBYTE(0x86)
  BUCK_BOOST_VDDN* = UBYTE(0xB0)
  TFT_VCOM_POWER* = UBYTE(0xB1)
  EN_BUF* = UBYTE(0xB6)
  BOOST_VDDP_EN* = UBYTE(0xB7)
  CCSET* = UBYTE(0xE0)
  PWS* = UBYTE(0xE3)
  CMD66* = UBYTE(0xF0)

  epdCsMPin = UWORD(8)
  epdCsSPin = UWORD(7)
  epdDcPin = UWORD(25)
  epdRstPin = UWORD(17)
  epdBusyPin = UWORD(24)
  epdPwrPin = UWORD(18)
  busyLogLoopInterval = 100
  busyLogMinIntervalMs = 1000.0
  busyWaitTimeoutMs = 120000.0

  psrV = [UBYTE(0xDF), UBYTE(0x69)]
  pwrV = [UBYTE(0x0F), UBYTE(0x00), UBYTE(0x28), UBYTE(0x2C), UBYTE(0x28), UBYTE(0x38)]
  pofV = [UBYTE(0x00)]
  drfV = [UBYTE(0x00)]
  cdiV = [UBYTE(0xF7)]
  tconV = [UBYTE(0x03), UBYTE(0x03)]
  tresV = [UBYTE(0x04), UBYTE(0xB0), UBYTE(0x03), UBYTE(0x20)]
  cmd66V = [UBYTE(0x49), UBYTE(0x55), UBYTE(0x13), UBYTE(0x5D), UBYTE(0x05), UBYTE(0x10)]
  enBufV = [UBYTE(0x07)]
  ccsetV = [UBYTE(0x01)]
  pwsV = [UBYTE(0x22)]
  anTmV = [
    UBYTE(0xC0), UBYTE(0x1C), UBYTE(0x1C), UBYTE(0xCC), UBYTE(0xCC),
    UBYTE(0xCC), UBYTE(0x15), UBYTE(0x15), UBYTE(0x55)
  ]
  agidV = [UBYTE(0x10)]
  btstPV = [UBYTE(0xE8), UBYTE(0x28)]
  boostVddpEnV = [UBYTE(0x01)]
  btstNV = [UBYTE(0xE8), UBYTE(0x28)]
  buckBoostVddnV = [UBYTE(0x01)]
  tftVcomPowerV = [UBYTE(0x02)]

type
  UByteArray = UncheckedArray[UBYTE]

var
  dataLogCounter = 0
  dataBytesCurrentCommand = 0

proc capturePinStates(): JsonNode =
  %*{
    "busy": DEV_Digital_Read(epdBusyPin).int,
    "rst": DEV_Digital_Read(epdRstPin).int,
    "dc": DEV_Digital_Read(epdDcPin).int,
    "csM": DEV_Digital_Read(epdCsMPin).int,
    "csS": DEV_Digital_Read(epdCsSPin).int,
    "pwr": DEV_Digital_Read(epdPwrPin).int
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

proc logDataByte(data: UBYTE) =
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

proc epd13in3eCsAll(value: UBYTE) =
  DEV_Digital_Write(epdCsMPin, value)
  DEV_Digital_Write(epdCsSPin, value)

proc epd13in3eSendCommand(reg: UBYTE) =
  logCommand(reg)
  DEV_SPI_SendData(reg)

proc epd13in3eSendData(data: UBYTE) =
  DEV_SPI_SendData(data)
  logDataByte(data)

proc epd13in3eSendDataBuffer(buffer: ptr UBYTE; length: int) =
  if buffer.isNil or length <= 0:
    return

  if driverDebugLogsEnabled():
    let bytes = cast[ptr UByteArray](buffer)
    let previewCount = min(length, max(0, 16 - dataLogCounter))
    let oldBytesSent = dataBytesCurrentCommand
    for i in 0 ..< previewCount:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "index": oldBytesSent + i + 1,
        "data": bytes[i].int,
        "dataHex": &"0x{toHex(bytes[i].int, 2)}"
      })

    let nextBytesSent = dataBytesCurrentCommand + length
    if dataLogCounter < 16 and dataLogCounter + length > 16:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "message": "Further data logging suppressed for this command",
        "bytesSent": oldBytesSent + 16 - dataLogCounter + 1
      })
    elif dataLogCounter == 16:
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "message": "Further data logging suppressed for this command",
        "bytesSent": oldBytesSent
      })

    if nextBytesSent >= 4096 and (oldBytesSent div 4096) != (nextBytesSent div 4096):
      logDriverDebug(%*{
        "event": "driver:waveshare:data",
        "message": "Data transfer progress",
        "bytesSent": nextBytesSent
      })

  DEV_SPI_SendData_nByte(buffer, UDOUBLE(length))
  dataBytesCurrentCommand += length
  dataLogCounter += length

proc epd13in3eSpiSend(cmd: UBYTE; data: openArray[UBYTE]) =
  epd13in3eSendCommand(cmd)
  for byte in data:
    epd13in3eSendData(byte)

proc epd13in3eReset() =
  logDebug("reset:start")
  DEV_Digital_Write(epdRstPin, UBYTE(1))
  DEV_Delay_ms(UDOUBLE(30))
  DEV_Digital_Write(epdRstPin, UBYTE(0))
  DEV_Delay_ms(UDOUBLE(30))
  DEV_Digital_Write(epdRstPin, UBYTE(1))
  DEV_Delay_ms(UDOUBLE(30))
  DEV_Digital_Write(epdRstPin, UBYTE(0))
  DEV_Delay_ms(UDOUBLE(30))
  DEV_Digital_Write(epdRstPin, UBYTE(1))
  DEV_Delay_ms(UDOUBLE(30))
  logDebug("reset:done")

proc epd13in3eReadBusyH(stage = "waitForHigh") =
  let startTime = getMonoTime()
  var loopCount = 0
  var lastLog = startTime
  let initialState = DEV_Digital_Read(epdBusyPin)
  var observedLow = initialState == UBYTE(0)
  var lowStartTime = startTime
  var timedOut = false
  logDebug("busy:wait:start", %*{
    "stage": stage,
    "initialState": initialState.int,
    "timeoutMs": busyWaitTimeoutMs,
    "pins": capturePinStates()
  })

  while DEV_Digital_Read(epdBusyPin) == UBYTE(0):
    if not observedLow:
      observedLow = true
      lowStartTime = getMonoTime()

    if durationToMilliseconds(getMonoTime() - startTime) >= busyWaitTimeoutMs:
      timedOut = true
      break

    DEV_Delay_ms(UDOUBLE(10))
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

  DEV_Delay_ms(UDOUBLE(20))

  let endTime = getMonoTime()
  let waitForLowMs =
    if observedLow:
      durationToMilliseconds(lowStartTime - startTime)
    else:
      0.0
  let waitForHighMs =
    if observedLow:
      durationToMilliseconds(endTime - lowStartTime)
    else:
      0.0

  logDebug("busy:wait:end", %*{
    "stage": stage,
    "durationMs": durationToMilliseconds(endTime - startTime),
    "loops": loopCount,
    "finalState": DEV_Digital_Read(epdBusyPin).int,
    "observedLow": observedLow,
    "waitedForLowMs": waitForLowMs,
    "waitedForHighMs": waitForHighMs,
    "timedOutWaitingForHigh": timedOut,
    "pins": capturePinStates()
  })

  if timedOut:
    raise newException(Exception, &"Timed out waiting for Waveshare 13.3in E busy pin during {stage}")

proc epd13in3eTurnOnDisplay() =
  logDebug("turnOnDisplay:start")

  logDebug("turnOnDisplay:powerOn")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSendCommand(PON)
  epd13in3eCsAll(UBYTE(1))
  epd13in3eReadBusyH("turnOnDisplay:powerOn")

  DEV_Delay_ms(UDOUBLE(50))

  logDebug("turnOnDisplay:refresh")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(DRF, drfV)
  epd13in3eCsAll(UBYTE(1))
  epd13in3eReadBusyH("turnOnDisplay:refresh")

  logDebug("turnOnDisplay:powerOff")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(POF, pofV)
  epd13in3eCsAll(UBYTE(1))
  logDebug("turnOnDisplay:done")

proc EPD_13IN3E_Init*() =
  logDebug("init:start")
  epd13in3eReset()
  epd13in3eReadBusyH("init:reset")

  logDebug("init:analogTiming")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(AN_TM, anTmV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:cmd66")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(CMD66, cmd66V)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:panelSetting")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(PSR, psrV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:vcomAndDataInterval")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(CDI, cdiV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:tcon")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(TCON, tconV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:agid")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(AGID, agidV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:powerSaving")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(PWS, pwsV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:ccset")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(CCSET, ccsetV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:resolution")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSpiSend(TRES, tresV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:power")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(PWR, pwrV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:enableBuffer")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(EN_BUF, enBufV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:boosterPositive")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(BTST_P, btstPV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:boostVddp")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(BOOST_VDDP_EN, boostVddpEnV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:boosterNegative")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(BTST_N, btstNV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:buckBoostVddn")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(BUCK_BOOST_VDDN, buckBoostVddnV)
  epd13in3eCsAll(UBYTE(1))

  logDebug("init:tftVcomPower")
  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSpiSend(TFT_VCOM_POWER, tftVcomPowerV)
  epd13in3eCsAll(UBYTE(1))
  logDebug("init:done")

proc EPD_13IN3E_Clear*(color: UBYTE) =
  let
    packedColor = UBYTE((color shl 4) or color)
    halfBufferBytes = EPD_13IN3E_WIDTH * EPD_13IN3E_HEIGHT div 4

  var buffer = newSeq[UBYTE](halfBufferBytes)
  for i in 0 ..< halfBufferBytes:
    buffer[i] = packedColor

  logDebug("clear:start", %*{"color": color.int, "halfBufferBytes": halfBufferBytes})

  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  epd13in3eSendDataBuffer(addr buffer[0], halfBufferBytes)
  epd13in3eCsAll(UBYTE(1))

  DEV_Digital_Write(epdCsSPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  epd13in3eSendDataBuffer(addr buffer[0], halfBufferBytes)
  epd13in3eCsAll(UBYTE(1))

  logDebug("clear:dataWritten", %*{"totalBytes": halfBufferBytes * 2})
  epd13in3eTurnOnDisplay()

proc EPD_13IN3E_Show7Block*() =
  const colorSeven = [
    UBYTE(EPD_13IN3E_BLACK),
    UBYTE(EPD_13IN3E_WHITE),
    UBYTE(EPD_13IN3E_YELLOW),
    UBYTE(EPD_13IN3E_RED),
    UBYTE(EPD_13IN3E_BLUE),
    UBYTE(EPD_13IN3E_GREEN),
    UBYTE(EPD_13IN3E_BLACK),
    UBYTE(EPD_13IN3E_WHITE)
  ]

  logDebug("show7Block:start", %*{"blocks": colorSeven.len, "bytesPerBlock": 60000})

  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  for color in colorSeven:
    for _ in 0 ..< 60000:
      epd13in3eSendData(UBYTE((color shl 4) or color))
  epd13in3eCsAll(UBYTE(1))

  DEV_Digital_Write(epdCsSPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  for color in colorSeven:
    for _ in 0 ..< 60000:
      epd13in3eSendData(UBYTE((color shl 4) or color))
  epd13in3eCsAll(UBYTE(1))

  logDebug("show7Block:dataWritten", %*{"totalBytes": colorSeven.len * 60000 * 2})
  epd13in3eTurnOnDisplay()

proc EPD_13IN3E_Display*(image: ptr UBYTE) =
  if image.isNil:
    logDebug("display:image:nil")
    return

  let
    width =
      if (EPD_13IN3E_WIDTH and 1) == 0:
        EPD_13IN3E_WIDTH div 2
      else:
        EPD_13IN3E_WIDTH div 2 + 1
    width1 =
      if (width and 1) == 0:
        width div 2
      else:
        width div 2 + 1
    height = EPD_13IN3E_HEIGHT
    buffer = cast[ptr UByteArray](image)
    totalBytes = width * height

  logDebug("display:start", %*{
    "widthBytes": width,
    "halfWidthBytes": width1,
    "height": height,
    "totalBytes": totalBytes
  })

  if driverDebugLogsEnabled() and totalBytes > 0:
    let previewCount = min(totalBytes, 16)
    var preview = newSeq[int](previewCount)
    for i in 0 ..< previewCount:
      preview[i] = buffer[i].int
    logDriverDebug(%*{
      "event": "driver:waveshare:dataPreview", "count": previewCount,
      "bytes": preview
    })

  DEV_Digital_Write(epdCsMPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  for i in 0 ..< height:
    epd13in3eSendDataBuffer(unsafeAddr buffer[i * width], width1)
  epd13in3eCsAll(UBYTE(1))

  DEV_Digital_Write(epdCsSPin, UBYTE(0))
  epd13in3eSendCommand(DTM)
  for i in 0 ..< height:
    epd13in3eSendDataBuffer(unsafeAddr buffer[i * width + width1], width1)
  epd13in3eCsAll(UBYTE(1))

  logDebug("display:dataWritten", %*{"totalBytes": totalBytes})
  epd13in3eTurnOnDisplay()

proc EPD_13IN3E_Sleep*() =
  logDebug("sleep:start")
  epd13in3eCsAll(UBYTE(0))
  epd13in3eSendCommand(0x07) # DEEP_SLEEP
  epd13in3eSendData(0xA5)
  epd13in3eCsAll(UBYTE(1))
  logDebug("sleep:done")
