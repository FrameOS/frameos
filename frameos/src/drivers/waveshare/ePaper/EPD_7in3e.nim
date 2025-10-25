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
  DEV_Config

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

template debug(msg: string) =
  when defined(debug):
    echo msg

proc epd7in3eReset() =
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(0))
  DEV_Delay_ms(UDOUBLE(2))
  DEV_Digital_Write(UWORD(EPD_RST_PIN), UBYTE(1))
  DEV_Delay_ms(UDOUBLE(20))

proc epd7in3eSendCommand(reg: UBYTE) =
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(0))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(reg)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

proc epd7in3eSendData(data: UBYTE) =
  DEV_Digital_Write(UWORD(EPD_DC_PIN), UBYTE(1))
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(0))
  DEV_SPI_WriteByte(data)
  DEV_Digital_Write(UWORD(EPD_CS_PIN), UBYTE(1))

proc epd7in3eReadBusyH() =
  debug("e-Paper busy H")
  while DEV_Digital_Read(UWORD(EPD_BUSY_PIN)) == UBYTE(0):
    DEV_Delay_ms(UDOUBLE(1))
  debug("e-Paper busy H release")

proc epd7in3eTurnOnDisplay() =
  epd7in3eSendCommand(0x04) # POWER_ON
  epd7in3eReadBusyH()

  ## Second setting
  epd7in3eSendCommand(0x06)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x17)
  epd7in3eSendData(0x49)

  epd7in3eSendCommand(0x12) # DISPLAY_REFRESH
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()

  epd7in3eSendCommand(0x02) # POWER_OFF
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()

proc EPD_7IN3E_Init*() =
  epd7in3eReset()
  epd7in3eReadBusyH()
  DEV_Delay_ms(UDOUBLE(30))

  epd7in3eSendCommand(0xAA)
  epd7in3eSendData(0x49)
  epd7in3eSendData(0x55)
  epd7in3eSendData(0x20)
  epd7in3eSendData(0x08)
  epd7in3eSendData(0x09)
  epd7in3eSendData(0x18)

  epd7in3eSendCommand(0x01)
  epd7in3eSendData(0x3F)

  epd7in3eSendCommand(0x00)
  epd7in3eSendData(0x5F)
  epd7in3eSendData(0x69)

  epd7in3eSendCommand(0x03)
  epd7in3eSendData(0x00)
  epd7in3eSendData(0x54)
  epd7in3eSendData(0x00)
  epd7in3eSendData(0x44)

  epd7in3eSendCommand(0x05)
  epd7in3eSendData(0x40)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x2C)

  epd7in3eSendCommand(0x06)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x17)
  epd7in3eSendData(0x49)

  epd7in3eSendCommand(0x08)
  epd7in3eSendData(0x6F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x1F)
  epd7in3eSendData(0x22)

  epd7in3eSendCommand(0x30)
  epd7in3eSendData(0x03)

  epd7in3eSendCommand(0x50)
  epd7in3eSendData(0x3F)

  epd7in3eSendCommand(0x60)
  epd7in3eSendData(0x02)
  epd7in3eSendData(0x00)

  epd7in3eSendCommand(0x61)
  epd7in3eSendData(0x03)
  epd7in3eSendData(0x20)
  epd7in3eSendData(0x01)
  epd7in3eSendData(0xE0)

  epd7in3eSendCommand(0x84)
  epd7in3eSendData(0x01)

  epd7in3eSendCommand(0xE3)
  epd7in3eSendData(0x2F)

  epd7in3eSendCommand(0x04)
  epd7in3eReadBusyH()

proc EPD_7IN3E_Init_Fast*() =
  ## No dedicated fast initialisation sequence is available in the original
  ## driver, so we fall back to the standard initialisation routine.
  EPD_7IN3E_Init()

proc EPD_7IN3E_Clear*(color: UBYTE) =
  let width =
    if (EPD_7IN3E_WIDTH and 1) == 0:
      EPD_7IN3E_WIDTH div 2
    else:
      EPD_7IN3E_WIDTH div 2 + 1
  let height = EPD_7IN3E_HEIGHT

  epd7in3eSendCommand(0x10)
  for _ in 0 ..< height:
    for _ in 0 ..< width:
      let packed = (color shl 4) or color
      epd7in3eSendData(UBYTE(packed))

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

  epd7in3eSendCommand(0x10)
  for color in colorSeven:
    for _ in 0 ..< 20000:
      let packed = (color shl 4) or color
      epd7in3eSendData(UBYTE(packed))

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

  var k = 0
  var o = 0

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

  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Display*(image: ptr UBYTE) =
  if image.isNil:
    return

  let width =
    if (EPD_7IN3E_WIDTH and 1) == 0:
      EPD_7IN3E_WIDTH div 2
    else:
      EPD_7IN3E_WIDTH div 2 + 1
  let height = EPD_7IN3E_HEIGHT
  let buffer = cast[ptr UByteArray](image)

  epd7in3eSendCommand(0x10)
  for j in 0 ..< height:
    for i in 0 ..< width:
      let idx = i + j * width
      epd7in3eSendData(buffer[idx])

  epd7in3eTurnOnDisplay()

proc EPD_7IN3E_Sleep*() =
  epd7in3eSendCommand(0x02)
  epd7in3eSendData(0x00)
  epd7in3eReadBusyH()

  epd7in3eSendCommand(0x07)
  epd7in3eSendData(0xA5)
