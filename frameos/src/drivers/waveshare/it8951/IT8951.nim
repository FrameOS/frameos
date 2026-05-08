## ***************************************************************************
##  | File        :   EPD_IT8951.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   IT8951 Common driver
##  | Info        :   Native Nim implementation of the Waveshare driver
## ----------------
##  | This version:   V1.0
##  | Date        :   2019-09-17
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
  strformat,
  times

var
  INIT_Mode* = UWORD(0)
  GC16_Mode* = UWORD(2)
  # A2_Mode's value is not fixed; it is decided by the firmware LUT.
  A2_Mode* = UWORD(6)

type
  IT8951_Load_Img_Info* = object
    Endian_Type*: UWORD
    Pixel_Format*: UWORD
    Rotate*: UWORD
    Source_Buffer_Addr*: ptr UBYTE
    Target_Memory_Addr*: UDOUBLE

  IT8951_Area_Img_Info* = object
    Area_X*: UWORD
    Area_Y*: UWORD
    Area_W*: UWORD
    Area_H*: UWORD

  IT8951_Dev_Info* = object
    Panel_W*: UWORD
    Panel_H*: UWORD
    Memory_Addr_L*: UWORD
    Memory_Addr_H*: UWORD
    FW_Version*: array[8, UWORD]
    LUT_Version*: array[8, UWORD]

  UWordArray = UncheckedArray[UWORD]

## -----------------------------------------------------------------------
## IT8951 Command defines
## ------------------------------------------------------------------------

const
  IT8951_TCON_SYS_RUN* = UWORD(0x0001)
  IT8951_TCON_STANDBY* = UWORD(0x0002)
  IT8951_TCON_SLEEP* = UWORD(0x0003)
  IT8951_TCON_REG_RD* = UWORD(0x0010)
  IT8951_TCON_REG_WR* = UWORD(0x0011)
  IT8951_TCON_MEM_BST_RD_T* = UWORD(0x0012)
  IT8951_TCON_MEM_BST_RD_S* = UWORD(0x0013)
  IT8951_TCON_MEM_BST_WR* = UWORD(0x0014)
  IT8951_TCON_MEM_BST_END* = UWORD(0x0015)
  IT8951_TCON_LD_IMG* = UWORD(0x0020)
  IT8951_TCON_LD_IMG_AREA* = UWORD(0x0021)
  IT8951_TCON_LD_IMG_END* = UWORD(0x0022)
  USDEF_I80_CMD_DPY_AREA* = UWORD(0x0034)
  USDEF_I80_CMD_GET_DEV_INFO* = UWORD(0x0302)
  USDEF_I80_CMD_DPY_BUF_AREA* = UWORD(0x0037)
  USDEF_I80_CMD_VCOM* = UWORD(0x0039)

## -----------------------------------------------------------------------
## IT8951 Mode defines
## ------------------------------------------------------------------------

const
  IT8951_ROTATE_0* = UWORD(0)
  IT8951_ROTATE_90* = UWORD(1)
  IT8951_ROTATE_180* = UWORD(2)
  IT8951_ROTATE_270* = UWORD(3)
  IT8951_2BPP* = UWORD(0)
  IT8951_3BPP* = UWORD(1)
  IT8951_4BPP* = UWORD(2)
  IT8951_8BPP* = UWORD(3)
  IT8951_LDIMG_L_ENDIAN* = UWORD(0)
  IT8951_LDIMG_B_ENDIAN* = UWORD(1)

## -----------------------------------------------------------------------
## IT8951 Registers defines
## ------------------------------------------------------------------------

const
  DISPLAY_REG_BASE* = UWORD(0x1000)
  LUT0EWHR* = DISPLAY_REG_BASE + UWORD(0x00)
  LUT0XYR* = DISPLAY_REG_BASE + UWORD(0x40)
  LUT0BADDR* = DISPLAY_REG_BASE + UWORD(0x80)
  LUT0MFN* = DISPLAY_REG_BASE + UWORD(0xC0)
  LUT01AF* = DISPLAY_REG_BASE + UWORD(0x114)
  UP0SR* = DISPLAY_REG_BASE + UWORD(0x134)
  UP1SR* = DISPLAY_REG_BASE + UWORD(0x138)
  LUT0ABFRV* = DISPLAY_REG_BASE + UWORD(0x13C)
  UPBBADDR* = DISPLAY_REG_BASE + UWORD(0x17C)
  LUT0IMXY* = DISPLAY_REG_BASE + UWORD(0x180)
  LUTAFSR* = DISPLAY_REG_BASE + UWORD(0x224)
  BGVR* = DISPLAY_REG_BASE + UWORD(0x250)
  SYS_REG_BASE* = UWORD(0x0000)
  I80CPCR* = SYS_REG_BASE + UWORD(0x04)
  MCSR_BASE_ADDR* = UWORD(0x0200)
  MCSR* = MCSR_BASE_ADDR + UWORD(0x0000)
  LISAR* = MCSR_BASE_ADDR + UWORD(0x0008)

  writeCommandPreamble = UWORD(0x6000)
  writeDataPreamble = UWORD(0x0000)
  readDataPreamble = UWORD(0x1000)
  busyPinWaitTimeoutMs = 30_000.0
  displayReadyTimeoutMs = 300_000.0
  busyPinSpinLoopsBeforeDelay = 1000
  busyPinPollDelayMs = UDOUBLE(1)
  displayReadyPollDelayMs = UDOUBLE(50)
  it8951BusyTimeoutError = 1
  it8951DisplayTimeoutError = 2
  it8951InvalidArgumentError = 3

var
  lastStage = "idle"
  lastWaitMs = UDOUBLE(0)
  lastWaitLoops = UDOUBLE(0)
  lastBusyPin = UBYTE(0)
  lastLutafsr = UWORD(0)
  lastErrorCode = 0
  lastErrorMessage = ""

proc EPD_IT8951_ClearLastError*() =
  lastErrorCode = 0
  lastErrorMessage = ""

proc EPD_IT8951_GetLastErrorCode*(): int =
  lastErrorCode

proc EPD_IT8951_GetLastErrorMessage*(): string =
  lastErrorMessage

proc EPD_IT8951_GetLastStage*(): string =
  lastStage

proc EPD_IT8951_GetLastWaitMs*(): UDOUBLE =
  lastWaitMs

proc EPD_IT8951_GetLastWaitLoops*(): UDOUBLE =
  lastWaitLoops

proc EPD_IT8951_GetLastBusyPin*(): UBYTE =
  lastBusyPin

proc EPD_IT8951_GetLastLUTAFSR*(): UWORD =
  lastLutafsr

proc setStage(stage: string) =
  lastStage = stage

proc setError(code: int; message: string) =
  if lastErrorCode == 0:
    lastErrorCode = code
    lastErrorMessage = message

proc toUdouble(value: int): UDOUBLE =
  if value <= 0:
    UDOUBLE(0)
  elif value.uint64 > uint32.high.uint64:
    UDOUBLE(uint32.high)
  else:
    UDOUBLE(value)

proc elapsedMs(startSeconds: float): float =
  max(0.0, (epochTime() - startSeconds) * 1000.0)

proc recordWait(startSeconds: float; loops: int; busyPin: UBYTE) =
  lastWaitMs = toUdouble(elapsedMs(startSeconds).int)
  lastWaitLoops = toUdouble(loops)
  lastBusyPin = busyPin

proc hasError(): bool =
  lastErrorCode != 0

proc writeWord(value: UWORD) =
  DEV_SPI_WriteByte(UBYTE((value shr 8) and UWORD(0xFF)))
  DEV_SPI_WriteByte(UBYTE(value and UWORD(0xFF)))

proc readWord(): UWORD =
  (DEV_SPI_ReadByte().UWORD shl 8) or DEV_SPI_ReadByte().UWORD

proc EPD_IT8951_Reset() =
  setStage("reset")
  DEV_Digital_Write(EPD_RST_PIN, UBYTE(HIGH))
  DEV_Delay_ms(UDOUBLE(200))
  DEV_Digital_Write(EPD_RST_PIN, UBYTE(LOW))
  DEV_Delay_ms(UDOUBLE(10))
  DEV_Digital_Write(EPD_RST_PIN, UBYTE(HIGH))
  DEV_Delay_ms(UDOUBLE(200))

proc EPD_IT8951_ReadBusy(stage = "readBusy"): bool =
  setStage(stage)
  let startSeconds = epochTime()
  var loops = 0
  var busyState = DEV_Digital_Read(EPD_BUSY_PIN)

  while busyState == UBYTE(0):
    inc loops
    if elapsedMs(startSeconds) >= busyPinWaitTimeoutMs:
      recordWait(startSeconds, loops, busyState)
      setError(
        it8951BusyTimeoutError,
        &"Timed out waiting for IT8951 busy pin during {stage}"
      )
      return false
    if loops >= busyPinSpinLoopsBeforeDelay:
      DEV_Delay_ms(busyPinPollDelayMs)
    busyState = DEV_Digital_Read(EPD_BUSY_PIN)

  recordWait(startSeconds, loops, busyState)
  true

proc EPD_IT8951_WriteCommand(command: UWORD) =
  if hasError() or not EPD_IT8951_ReadBusy("writeCommand:preamble"):
    return

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(LOW))
  writeWord(writeCommandPreamble)

  if not EPD_IT8951_ReadBusy("writeCommand:command"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return

  writeWord(command)
  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc EPD_IT8951_WriteData(data: UWORD) =
  if hasError() or not EPD_IT8951_ReadBusy("writeData:preamble"):
    return

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(LOW))
  writeWord(writeDataPreamble)

  if not EPD_IT8951_ReadBusy("writeData:data"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return

  writeWord(data)
  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc EPD_IT8951_WriteMuitiData(dataBuf: ptr UWORD; length: UDOUBLE) =
  if hasError() or dataBuf.isNil or length == 0:
    return
  if not EPD_IT8951_ReadBusy("writeMultiData:preamble"):
    return

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(LOW))
  writeWord(writeDataPreamble)

  if not EPD_IT8951_ReadBusy("writeMultiData:data"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return

  let data = cast[ptr UWordArray](dataBuf)
  for i in 0 ..< length.int:
    writeWord(data[i])

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc EPD_IT8951_ReadData(): UWORD =
  if hasError() or not EPD_IT8951_ReadBusy("readData:preamble"):
    return UWORD(0)

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(LOW))
  writeWord(readDataPreamble)

  if not EPD_IT8951_ReadBusy("readData:dummy"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return UWORD(0)

  discard readWord()

  if not EPD_IT8951_ReadBusy("readData:data"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return UWORD(0)

  result = readWord()
  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc EPD_IT8951_ReadMultiData(dataBuf: ptr UWORD; length: UDOUBLE) =
  if hasError() or dataBuf.isNil or length == 0:
    return
  if not EPD_IT8951_ReadBusy("readMultiData:preamble"):
    return

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(LOW))
  writeWord(readDataPreamble)

  if not EPD_IT8951_ReadBusy("readMultiData:dummy"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return

  discard readWord()

  if not EPD_IT8951_ReadBusy("readMultiData:data"):
    DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))
    return

  let data = cast[ptr UWordArray](dataBuf)
  for i in 0 ..< length.int:
    data[i] = readWord()

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc EPD_IT8951_WriteMultiArg(argCmd: UWORD; args: openArray[UWORD]) =
  EPD_IT8951_WriteCommand(argCmd)
  if hasError():
    return

  for arg in args:
    EPD_IT8951_WriteData(arg)
    if hasError():
      return

proc EPD_IT8951_ReadReg*(regAddress: UWORD): UWORD =
  EPD_IT8951_WriteCommand(IT8951_TCON_REG_RD)
  EPD_IT8951_WriteData(regAddress)
  if hasError():
    return UWORD(0)
  EPD_IT8951_ReadData()

proc EPD_IT8951_WriteReg*(regAddress: UWORD; regValue: UWORD) =
  EPD_IT8951_WriteCommand(IT8951_TCON_REG_WR)
  EPD_IT8951_WriteData(regAddress)
  EPD_IT8951_WriteData(regValue)

proc EPD_IT8951_GetVCOM*(): UWORD =
  EPD_IT8951_WriteCommand(USDEF_I80_CMD_VCOM)
  EPD_IT8951_WriteData(UWORD(0x0000))
  if hasError():
    return UWORD(0)
  EPD_IT8951_ReadData()

proc EPD_IT8951_SetVCOM*(vcom: UWORD) =
  EPD_IT8951_WriteCommand(USDEF_I80_CMD_VCOM)
  EPD_IT8951_WriteData(UWORD(0x0001))
  EPD_IT8951_WriteData(vcom)

proc EPD_IT8951_LoadImgStart(loadImgInfo: ptr IT8951_Load_Img_Info) {.used.} =
  if hasError() or loadImgInfo.isNil:
    return

  let info = loadImgInfo[]
  let args =
    (info.Endian_Type shl 8) or
    (info.Pixel_Format shl 4) or
    info.Rotate

  EPD_IT8951_WriteCommand(IT8951_TCON_LD_IMG)
  EPD_IT8951_WriteData(args)

proc EPD_IT8951_LoadImgAreaStart(
  loadImgInfo: ptr IT8951_Load_Img_Info;
  areaImgInfo: ptr IT8951_Area_Img_Info
) =
  if hasError() or loadImgInfo.isNil or areaImgInfo.isNil:
    return

  let
    loadInfo = loadImgInfo[]
    areaInfo = areaImgInfo[]
    args = [
      (loadInfo.Endian_Type shl 8) or
        (loadInfo.Pixel_Format shl 4) or
        loadInfo.Rotate,
      areaInfo.Area_X,
      areaInfo.Area_Y,
      areaInfo.Area_W,
      areaInfo.Area_H
    ]

  EPD_IT8951_WriteMultiArg(IT8951_TCON_LD_IMG_AREA, args)

proc EPD_IT8951_LoadImgEnd() =
  EPD_IT8951_WriteCommand(IT8951_TCON_LD_IMG_END)

proc EPD_IT8951_GetSystemInfo(): IT8951_Dev_Info =
  var words: array[20, UWORD]

  EPD_IT8951_WriteCommand(USDEF_I80_CMD_GET_DEV_INFO)
  if hasError():
    return result

  EPD_IT8951_ReadMultiData(addr words[0], UDOUBLE(words.len))
  if hasError():
    return result

  result.Panel_W = words[0]
  result.Panel_H = words[1]
  result.Memory_Addr_L = words[2]
  result.Memory_Addr_H = words[3]
  for i in 0 ..< result.FW_Version.len:
    result.FW_Version[i] = words[4 + i]
  for i in 0 ..< result.LUT_Version.len:
    result.LUT_Version[i] = words[12 + i]

proc EPD_IT8951_SetTargetMemoryAddr(targetMemoryAddr: UDOUBLE) =
  let
    wordH = UWORD((targetMemoryAddr shr 16) and UDOUBLE(0x0000FFFF))
    wordL = UWORD(targetMemoryAddr and UDOUBLE(0x0000FFFF))

  EPD_IT8951_WriteReg(LISAR + UWORD(2), wordH)
  EPD_IT8951_WriteReg(LISAR, wordL)

proc EPD_IT8951_WaitForDisplayReady*() =
  setStage("waitForDisplayReady")
  let startSeconds = epochTime()
  var loops = 0

  while true:
    let lutafsr = EPD_IT8951_ReadReg(LUTAFSR)
    lastLutafsr = lutafsr
    if hasError():
      return
    if lutafsr == UWORD(0):
      break

    inc loops
    if elapsedMs(startSeconds) >= displayReadyTimeoutMs:
      recordWait(startSeconds, loops, lastBusyPin)
      setError(
        it8951DisplayTimeoutError,
        &"Timed out waiting for IT8951 display engine; LUTAFSR={lutafsr}"
      )
      return
    DEV_Delay_ms(displayReadyPollDelayMs)

  recordWait(startSeconds, loops, lastBusyPin)
  setStage("waitForDisplayReady:done")

proc sourceWords(loadImgInfo: ptr IT8951_Load_Img_Info): ptr UWordArray =
  cast[ptr UWordArray](loadImgInfo[].Source_Buffer_Addr)

proc EPD_IT8951_HostAreaPackedPixelWrite_1bp(
  loadImgInfo: ptr IT8951_Load_Img_Info;
  areaImgInfo: ptr IT8951_Area_Img_Info;
  packedWrite: bool
) =
  if hasError() or loadImgInfo.isNil or areaImgInfo.isNil:
    return
  if loadImgInfo[].Source_Buffer_Addr.isNil:
    setError(it8951InvalidArgumentError, "1bpp source buffer is nil")
    return

  EPD_IT8951_SetTargetMemoryAddr(loadImgInfo[].Target_Memory_Addr)
  EPD_IT8951_LoadImgAreaStart(loadImgInfo, areaImgInfo)
  if hasError():
    return

  let
    sourceBufferWidth = areaImgInfo[].Area_W.int div 2
    sourceBufferHeight = areaImgInfo[].Area_H.int
    sourceBufferLength = sourceBufferWidth * sourceBufferHeight
    sourceBuffer = sourceWords(loadImgInfo)

  if packedWrite:
    EPD_IT8951_WriteMuitiData(cast[ptr UWORD](sourceBuffer), UDOUBLE(sourceBufferLength))
  else:
    var index = 0
    for _ in 0 ..< sourceBufferHeight:
      for _ in 0 ..< sourceBufferWidth:
        EPD_IT8951_WriteData(sourceBuffer[index])
        inc index
        if hasError():
          return

  EPD_IT8951_LoadImgEnd()

proc EPD_IT8951_HostAreaPackedPixelWrite_2bp(
  loadImgInfo: ptr IT8951_Load_Img_Info;
  areaImgInfo: ptr IT8951_Area_Img_Info;
  packedWrite: bool
) =
  if hasError() or loadImgInfo.isNil or areaImgInfo.isNil:
    return
  if loadImgInfo[].Source_Buffer_Addr.isNil:
    setError(it8951InvalidArgumentError, "2bpp source buffer is nil")
    return

  EPD_IT8951_SetTargetMemoryAddr(loadImgInfo[].Target_Memory_Addr)
  EPD_IT8951_LoadImgAreaStart(loadImgInfo, areaImgInfo)
  if hasError():
    return

  let
    sourceBufferWidth = (areaImgInfo[].Area_W.int * 2 div 8) div 2
    sourceBufferHeight = areaImgInfo[].Area_H.int
    sourceBufferLength = sourceBufferWidth * sourceBufferHeight
    sourceBuffer = sourceWords(loadImgInfo)

  if packedWrite:
    EPD_IT8951_WriteMuitiData(cast[ptr UWORD](sourceBuffer), UDOUBLE(sourceBufferLength))
  else:
    var index = 0
    for _ in 0 ..< sourceBufferHeight:
      for _ in 0 ..< sourceBufferWidth:
        EPD_IT8951_WriteData(sourceBuffer[index])
        inc index
        if hasError():
          return

  EPD_IT8951_LoadImgEnd()

proc EPD_IT8951_HostAreaPackedPixelWrite_4bp(
  loadImgInfo: ptr IT8951_Load_Img_Info;
  areaImgInfo: ptr IT8951_Area_Img_Info;
  packedWrite: bool
) =
  if hasError() or loadImgInfo.isNil or areaImgInfo.isNil:
    return
  if loadImgInfo[].Source_Buffer_Addr.isNil:
    setError(it8951InvalidArgumentError, "4bpp source buffer is nil")
    return

  EPD_IT8951_SetTargetMemoryAddr(loadImgInfo[].Target_Memory_Addr)
  EPD_IT8951_LoadImgAreaStart(loadImgInfo, areaImgInfo)
  if hasError():
    return

  let
    sourceBufferWidth = (areaImgInfo[].Area_W.int * 4 div 8) div 2
    sourceBufferHeight = areaImgInfo[].Area_H.int
    sourceBufferLength = sourceBufferWidth * sourceBufferHeight
    sourceBuffer = sourceWords(loadImgInfo)

  if packedWrite:
    EPD_IT8951_WriteMuitiData(cast[ptr UWORD](sourceBuffer), UDOUBLE(sourceBufferLength))
  else:
    var index = 0
    for _ in 0 ..< sourceBufferHeight:
      for _ in 0 ..< sourceBufferWidth:
        EPD_IT8951_WriteData(sourceBuffer[index])
        inc index
        if hasError():
          return

  EPD_IT8951_LoadImgEnd()

proc EPD_IT8951_HostAreaPackedPixelWrite_8bp(
  loadImgInfo: ptr IT8951_Load_Img_Info;
  areaImgInfo: ptr IT8951_Area_Img_Info
) =
  if hasError() or loadImgInfo.isNil or areaImgInfo.isNil:
    return
  if loadImgInfo[].Source_Buffer_Addr.isNil:
    setError(it8951InvalidArgumentError, "8bpp source buffer is nil")
    return

  EPD_IT8951_SetTargetMemoryAddr(loadImgInfo[].Target_Memory_Addr)
  EPD_IT8951_LoadImgAreaStart(loadImgInfo, areaImgInfo)
  if hasError():
    return

  let
    sourceBufferWidth = (areaImgInfo[].Area_W.int * 8 div 8) div 2
    sourceBufferHeight = areaImgInfo[].Area_H.int
    sourceBuffer = sourceWords(loadImgInfo)

  var index = 0
  for _ in 0 ..< sourceBufferHeight:
    for _ in 0 ..< sourceBufferWidth:
      EPD_IT8951_WriteData(sourceBuffer[index])
      inc index
      if hasError():
        return

  EPD_IT8951_LoadImgEnd()

proc EPD_IT8951_Display_Area*(x: UWORD; y: UWORD; w: UWORD; h: UWORD; mode: UWORD) =
  let args = [x, y, w, h, mode]
  EPD_IT8951_WriteMultiArg(USDEF_I80_CMD_DPY_AREA, args)

proc EPD_IT8951_Display_AreaBuf*(
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  mode: UWORD;
  targetMemoryAddr: UDOUBLE
) =
  let args = [
    x,
    y,
    w,
    h,
    mode,
    UWORD(targetMemoryAddr and UDOUBLE(0x0000FFFF)),
    UWORD((targetMemoryAddr shr 16) and UDOUBLE(0x0000FFFF))
  ]
  EPD_IT8951_WriteMultiArg(USDEF_I80_CMD_DPY_BUF_AREA, args)

proc EPD_IT8951_Display_1bp(
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  mode: UWORD;
  targetMemoryAddr: UDOUBLE;
  backGrayVal: UBYTE;
  frontGrayVal: UBYTE
) =
  EPD_IT8951_WriteReg(UP1SR + UWORD(2), EPD_IT8951_ReadReg(UP1SR + UWORD(2)) or (UWORD(1) shl 2))
  EPD_IT8951_WriteReg(BGVR, (frontGrayVal.UWORD shl 8) or backGrayVal.UWORD)

  if targetMemoryAddr == UDOUBLE(0):
    EPD_IT8951_Display_Area(x, y, w, h, mode)
  else:
    EPD_IT8951_Display_AreaBuf(x, y, w, h, mode, targetMemoryAddr)

  EPD_IT8951_WaitForDisplayReady()

  EPD_IT8951_WriteReg(
    UP1SR + UWORD(2),
    EPD_IT8951_ReadReg(UP1SR + UWORD(2)) and (UWORD(0xFFFF) xor (UWORD(1) shl 2))
  )

proc Enhance_Driving_Capability*() =
  var regValue = EPD_IT8951_ReadReg(UWORD(0x0038))
  echo &"The reg value before writing is {regValue:x}"

  EPD_IT8951_WriteReg(UWORD(0x0038), UWORD(0x0602))

  regValue = EPD_IT8951_ReadReg(UWORD(0x0038))
  echo &"The reg value after writing is {regValue:x}"

proc EPD_IT8951_SystemRun*() =
  setStage("systemRun")
  EPD_IT8951_WriteCommand(IT8951_TCON_SYS_RUN)

proc EPD_IT8951_Standby*() =
  setStage("standby")
  EPD_IT8951_WriteCommand(IT8951_TCON_STANDBY)

proc EPD_IT8951_Sleep*() =
  setStage("sleep")
  EPD_IT8951_WriteCommand(IT8951_TCON_SLEEP)

proc EPD_IT8951_Init*(vcom: UWORD): IT8951_Dev_Info =
  setStage("init")
  EPD_IT8951_Reset()
  if hasError():
    return result

  EPD_IT8951_SystemRun()
  if hasError():
    return result

  result = EPD_IT8951_GetSystemInfo()
  if hasError():
    return result

  EPD_IT8951_WriteReg(I80CPCR, UWORD(0x0001))
  if hasError():
    return result

  if vcom != EPD_IT8951_GetVCOM():
    EPD_IT8951_SetVCOM(vcom)
    if not hasError():
      echo &"VCOM = -{EPD_IT8951_GetVCOM().float / 1000.0:.02f}V"

proc EPD_IT8951_Clear_Refresh*(devInfo: IT8951_Dev_Info; targetMemoryAddr: UDOUBLE; mode: UWORD) =
  let imageSize = (
    if (devInfo.Panel_W.uint32 * 4) mod 8 == 0:
      devInfo.Panel_W.uint32 * 4 div 8
    else:
      devInfo.Panel_W.uint32 * 4 div 8 + 1
  ) * devInfo.Panel_H.uint32

  if imageSize == 0:
    setError(it8951InvalidArgumentError, "clear image size is zero")
    return

  var frameBuf = newSeq[UBYTE](imageSize.int)
  for i in 0 ..< frameBuf.len:
    frameBuf[i] = UBYTE(0xFF)

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: addr frameBuf[0],
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_4BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: UWORD(0),
      Area_Y: UWORD(0),
      Area_W: devInfo.Panel_W,
      Area_H: devInfo.Panel_H
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_4bp(addr loadImgInfo, addr areaImgInfo, false)
  if hasError():
    return

  EPD_IT8951_Display_Area(UWORD(0), UWORD(0), devInfo.Panel_W, devInfo.Panel_H, mode)

proc EPD_IT8951_1bp_Refresh*(
  frameBuf: ptr UBYTE;
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  mode: UWORD;
  targetMemoryAddr: UDOUBLE;
  packedWrite: bool
) =
  if frameBuf.isNil:
    setError(it8951InvalidArgumentError, "1bpp refresh frame buffer is nil")
    return

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: frameBuf,
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_8BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: x div UWORD(8),
      Area_Y: y,
      Area_W: w div UWORD(8),
      Area_H: h
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_1bp(addr loadImgInfo, addr areaImgInfo, packedWrite)
  if hasError():
    return

  EPD_IT8951_Display_1bp(x, y, w, h, mode, targetMemoryAddr, UBYTE(0xF0), UBYTE(0x00))

proc EPD_IT8951_1bp_Multi_Frame_Write*(
  frameBuf: ptr UBYTE;
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  targetMemoryAddr: UDOUBLE;
  packedWrite: bool
) =
  if frameBuf.isNil:
    setError(it8951InvalidArgumentError, "1bpp multi-frame buffer is nil")
    return

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: frameBuf,
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_8BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: x div UWORD(8),
      Area_Y: y,
      Area_W: w div UWORD(8),
      Area_H: h
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_1bp(addr loadImgInfo, addr areaImgInfo, packedWrite)

proc EPD_IT8951_1bp_Multi_Frame_Refresh*(
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  targetMemoryAddr: UDOUBLE
) =
  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_Display_1bp(x, y, w, h, A2_Mode, targetMemoryAddr, UBYTE(0xF0), UBYTE(0x00))

proc EPD_IT8951_2bp_Refresh*(
  frameBuf: ptr UBYTE;
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  hold: bool;
  targetMemoryAddr: UDOUBLE;
  packedWrite: bool
) =
  if frameBuf.isNil:
    setError(it8951InvalidArgumentError, "2bpp refresh frame buffer is nil")
    return

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: frameBuf,
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_2BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: x,
      Area_Y: y,
      Area_W: w,
      Area_H: h
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_2bp(addr loadImgInfo, addr areaImgInfo, packedWrite)
  if hasError():
    return

  if hold:
    EPD_IT8951_Display_Area(x, y, w, h, GC16_Mode)
  else:
    EPD_IT8951_Display_AreaBuf(x, y, w, h, GC16_Mode, targetMemoryAddr)

proc EPD_IT8951_4bp_Refresh*(
  frameBuf: ptr UBYTE;
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  hold: bool;
  targetMemoryAddr: UDOUBLE;
  packedWrite: bool
) =
  if frameBuf.isNil:
    setError(it8951InvalidArgumentError, "4bpp refresh frame buffer is nil")
    return

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: frameBuf,
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_4BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: x,
      Area_Y: y,
      Area_W: w,
      Area_H: h
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_4bp(addr loadImgInfo, addr areaImgInfo, packedWrite)
  if hasError():
    return

  if hold:
    EPD_IT8951_Display_Area(x, y, w, h, GC16_Mode)
  else:
    EPD_IT8951_Display_AreaBuf(x, y, w, h, GC16_Mode, targetMemoryAddr)

proc EPD_IT8951_8bp_Refresh*(
  frameBuf: ptr UBYTE;
  x: UWORD;
  y: UWORD;
  w: UWORD;
  h: UWORD;
  hold: bool;
  targetMemoryAddr: UDOUBLE
) =
  if frameBuf.isNil:
    setError(it8951InvalidArgumentError, "8bpp refresh frame buffer is nil")
    return

  var
    loadImgInfo = IT8951_Load_Img_Info(
      Source_Buffer_Addr: frameBuf,
      Endian_Type: IT8951_LDIMG_L_ENDIAN,
      Pixel_Format: IT8951_8BPP,
      Rotate: IT8951_ROTATE_0,
      Target_Memory_Addr: targetMemoryAddr
    )
    areaImgInfo = IT8951_Area_Img_Info(
      Area_X: x,
      Area_Y: y,
      Area_W: w,
      Area_H: h
    )

  EPD_IT8951_WaitForDisplayReady()
  if hasError():
    return

  EPD_IT8951_HostAreaPackedPixelWrite_8bp(addr loadImgInfo, addr areaImgInfo)
  if hasError():
    return

  if hold:
    EPD_IT8951_Display_Area(x, y, w, h, GC16_Mode)
  else:
    EPD_IT8951_Display_AreaBuf(x, y, w, h, GC16_Mode, targetMemoryAddr)
