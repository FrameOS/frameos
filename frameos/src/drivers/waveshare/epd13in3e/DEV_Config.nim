## ***************************************************************************
##  | File        :   DEV_Config.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   Hardware underlying interface
##  | Info        :   Native Nim implementation for the 13.3" E driver
## ----------------
##  | This version:   V3.0
##  | Date        :   2019-07-31
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
  strformat,
  strutils

import lib/lgpio

const
  LFLAGS* = 0
  NUM_MAXBUF* = 4

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

const
  EPD_SCK_PIN* = UWORD(11)
  EPD_SI0_PIN* = UWORD(10)
  EPD_CS_M_PIN* = UWORD(8)
  EPD_CS_S_PIN* = UWORD(7)
  EPD_DC_PIN* = UWORD(25)
  EPD_RST_PIN* = UWORD(17)
  EPD_BUSY_PIN* = UWORD(24)
  EPD_PWR_PIN* = UWORD(18)

  # Compatibility names used by other Waveshare wrappers.
  EPD_CS_PIN* = EPD_CS_M_PIN
  EPD_MOSI_PIN* = EPD_SI0_PIN
  EPD_SCLK_PIN* = EPD_SCK_PIN

var
  gpioHandle = cint(-1)
  spiHandle = cint(-1)

proc DEV_SPI_SendData*(reg: UBYTE)

proc DEV_Digital_Write*(pin: UWORD; value: UBYTE) =
  discard lgGpioWrite(gpioHandle, pin.cint, value.cint)

proc DEV_Digital_Read*(pin: UWORD): UBYTE =
  let readValue = lgGpioRead(gpioHandle, pin.cint)
  if readValue <= 0:
    UBYTE(0)
  else:
    UBYTE(readValue)

proc DEV_SPI_WriteByte*(value: UBYTE) =
  if spiHandle < 0:
    DEV_SPI_SendData(value)
    return

  var data = value
  discard lgSpiWrite(spiHandle, cast[cstring](addr data), cint(1))

proc DEV_SPI_Write_nByte*(pData: ptr uint8; len: uint32) =
  if pData.isNil or len == 0:
    return

  if spiHandle < 0:
    let bytes = cast[ptr UncheckedArray[uint8]](pData)
    for i in 0 ..< len.int:
      DEV_SPI_SendData(bytes[i])
    return

  discard lgSpiWrite(spiHandle, cast[cstring](pData), len.cint)

proc DEV_GPIO_Mode*(pin: UWORD; mode: UWORD) =
  if mode == 0 or mode == UWORD(LG_SET_INPUT):
    discard lgGpioClaimInput(gpioHandle, LFLAGS.cint, pin.cint)
  else:
    discard lgGpioClaimOutput(gpioHandle, LFLAGS.cint, pin.cint, LG_LOW.cint)

proc DEV_Delay_ms*(xms: UDOUBLE) =
  lguSleep(xms.float / 1000.0)

proc fileContains(path: string, needle: string): bool =
  try:
    readFile(path).contains(needle)
  except CatchableError:
    false

proc devEquipmentTesting(): cint =
  stdout.write("Current environment: ")
  if fileContains("/proc/device-tree/model", "Raspberry Pi"):
    echo "Raspberry Pi"
    return 0

  let issue =
    try:
      readFile("/etc/issue")
    except CatchableError:
      ""

  for systemName in ["Raspbian", "Debian", "FrameOS", "Buildroot"]:
    if issue.contains(systemName):
      echo systemName
      return 0

  if fileContains("/etc/os-release", "ID=buildroot") or fileContains("/etc/os-release", "NAME=Buildroot"):
    echo "Buildroot"
    return 0

  echo "not recognized"
  echo "Built for Raspberry Pi, but unable to detect environment."
  echo "Perhaps you meant to 'make JETSON' instead?"
  -1

proc DEV_GPIO_Init*() =
  DEV_GPIO_Mode(EPD_SCK_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_SI0_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_CS_M_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_CS_S_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_DC_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_RST_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_BUSY_PIN, UWORD(0))
  DEV_GPIO_Mode(EPD_PWR_PIN, UWORD(1))

  DEV_Digital_Write(EPD_SCK_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_SI0_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_CS_M_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_CS_S_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_DC_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_RST_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_PWR_PIN, UBYTE(1))

proc DEV_SPI_SendData*(reg: UBYTE) =
  var value = reg
  DEV_GPIO_Mode(EPD_SI0_PIN, UWORD(1))
  for _ in 0 ..< 8:
    DEV_Digital_Write(EPD_SCK_PIN, UBYTE(0))
    if (value and 0x80) != 0:
      DEV_Digital_Write(EPD_SI0_PIN, UBYTE(1))
    else:
      DEV_Digital_Write(EPD_SI0_PIN, UBYTE(0))
    DEV_Digital_Write(EPD_SCK_PIN, UBYTE(1))
    value = value shl 1
  DEV_Digital_Write(EPD_SCK_PIN, UBYTE(0))

proc DEV_SPI_SendData_nByte*(pData: ptr UBYTE; len: UDOUBLE) =
  if pData.isNil or len == 0:
    return
  let bytes = cast[ptr UncheckedArray[UBYTE]](pData)
  for i in 0 ..< len.int:
    DEV_SPI_SendData(bytes[i])

proc DEV_SPI_SendnData*(reg: ptr UBYTE) =
  ## Kept for compatibility with the original header. The C implementation used
  ## sizeof(pointer), so callers should prefer DEV_SPI_SendData_nByte.
  if reg.isNil:
    return
  DEV_SPI_SendData(reg[])

proc DEV_SPI_ReadData*(): UBYTE =
  var value = UBYTE(0xFF)
  DEV_GPIO_Mode(EPD_SI0_PIN, UWORD(0))
  for _ in 0 ..< 8:
    DEV_Digital_Write(EPD_SCK_PIN, UBYTE(0))
    value = value shl 1
    if DEV_Digital_Read(EPD_SI0_PIN) != 0:
      value = value or UBYTE(0x01)
    else:
      value = value and UBYTE(0xFE)
    DEV_Digital_Write(EPD_SCK_PIN, UBYTE(1))
  DEV_Digital_Write(EPD_SCK_PIN, UBYTE(0))
  value

proc determineGpioChip(): cint =
  try:
    if readFile("/proc/cpuinfo").contains("Raspberry Pi 5"):
      return 4
  except CatchableError:
    discard
  0

proc DEV_Module_Init*(): UBYTE =
  if devEquipmentTesting() < 0:
    return UBYTE(1)

  let gpioChip = determineGpioChip()
  gpioHandle = lgGpiochipOpen(gpioChip)
  if gpioHandle < 0:
    echo &"gpiochip{gpioChip} Export Failed"
    return UBYTE(1)

  spiHandle = lgSpiOpen(0, 0, 10_000_000, 0)
  if spiHandle < 0:
    # The 13.3" E driver uses software SPI. Waveshare's C version opened
    # hardware SPI opportunistically and continued when /dev/spidev0.0 was
    # unavailable.
    spiHandle = cint(-1)

  DEV_GPIO_Init()
  UBYTE(0)

proc DEV_Module_Exit*() =
  DEV_Digital_Write(EPD_CS_M_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_CS_S_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_DC_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_RST_PIN, UBYTE(0))
  DEV_Digital_Write(EPD_PWR_PIN, UBYTE(0))

  if spiHandle >= 0:
    discard lgSpiClose(spiHandle)
    spiHandle = cint(-1)
  if gpioHandle >= 0:
    discard lgGpiochipClose(gpioHandle)
    gpioHandle = cint(-1)
