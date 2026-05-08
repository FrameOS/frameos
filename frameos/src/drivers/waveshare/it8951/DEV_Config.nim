## ***************************************************************************
##  | File        :   DEV_Config.nim
##  | Author      :   Waveshare team (original C implementation)
##  | Nim Port    :   FrameOS maintainers
##  | Function    :   Hardware underlying interface
##  | Info        :   Native Nim implementation for the IT8951 driver
## ----------------
##  | This version:   V3.0
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
  strformat,
  strutils

import lib/lgpio

const
  LFLAGS* = 0
  NUM_MAXBUF* = 4
  HIGH* = 0x1
  LOW* = 0x0

type
  UBYTE* = uint8
  UWORD* = uint16
  UDOUBLE* = uint32

const
  EPD_RST_PIN* = UWORD(17)
  EPD_CS_PIN* = UWORD(8)
  EPD_BUSY_PIN* = UWORD(24)

var
  gpioHandle = cint(-1)
  spiHandle = cint(-1)

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
    return

  var data = value
  discard lgSpiWrite(spiHandle, cast[cstring](addr data), cint(1))

proc DEV_SPI_ReadByte*(): UBYTE =
  if spiHandle < 0:
    return UBYTE(0)

  var data = UBYTE(0)
  discard lgSpiRead(spiHandle, cast[cstring](addr data), cint(1))
  data

proc DEV_Delay_ms*(xms: UDOUBLE) =
  lguSleep(xms.float / 1000.0)

proc DEV_Delay_us*(xus: UDOUBLE) =
  lguSleep(xus.float / 1_000_000.0)

proc DEV_GPIO_Mode*(pin: UWORD; mode: UWORD) =
  if mode == 0 or mode == UWORD(LG_SET_INPUT):
    discard lgGpioClaimInput(gpioHandle, LFLAGS.cint, pin.cint)
  else:
    discard lgGpioClaimOutput(gpioHandle, LFLAGS.cint, pin.cint, LG_LOW.cint)

proc DEV_GPIO_Init*() =
  DEV_GPIO_Mode(EPD_BUSY_PIN, UWORD(0))
  DEV_GPIO_Mode(EPD_RST_PIN, UWORD(1))
  DEV_GPIO_Mode(EPD_CS_PIN, UWORD(1))

  DEV_Digital_Write(EPD_CS_PIN, UBYTE(HIGH))

proc determineGpioChip(): cint =
  try:
    if readFile("/proc/cpuinfo").contains("Raspberry Pi 5"):
      return 4
  except CatchableError:
    discard
  0

proc DEV_Module_Init*(): UBYTE =
  let gpioChip = determineGpioChip()
  gpioHandle = lgGpiochipOpen(gpioChip)
  if gpioHandle < 0:
    echo &"gpiochip{gpioChip} Export Failed"
    return UBYTE(1)

  spiHandle = lgSpiOpen(0, 0, 12_500_000, 0)
  if spiHandle < 0:
    echo &"lgSpiOpen failed: {spiHandle}"
    discard lgGpiochipClose(gpioHandle)
    gpioHandle = cint(-1)
    return UBYTE(1)

  DEV_GPIO_Init()
  UBYTE(0)

proc DEV_Module_Exit*() =
  if spiHandle >= 0:
    discard lgSpiClose(spiHandle)
    spiHandle = cint(-1)
  if gpioHandle >= 0:
    discard lgGpiochipClose(gpioHandle)
    gpioHandle = cint(-1)
