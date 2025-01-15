{.compile: "EPD_13in3e.c".}
## ***************************************************************************
##  | File      	:	EPD_12in48.h
##  | Author      :   Waveshare team
##  | Function    :   Electronic paper driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2018-11-29
##  | Info        :
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
  EPD_13IN3E_WIDTH* = 1200
  EPD_13IN3E_HEIGHT* = 1600
  EPD_13IN3E_BLACK* = 0x0
  EPD_13IN3E_WHITE* = 0x1
  EPD_13IN3E_YELLOW* = 0x2
  EPD_13IN3E_RED* = 0x3
    # 0x4 ??
  EPD_13IN3E_BLUE* = 0x5
  EPD_13IN3E_GREEN* = 0x6
  PSR* = 0x00
  PWR* = 0x01
  POF* = 0x02
  PON* = 0x04
  BTST_N* = 0x05
  BTST_P* = 0x06
  DTM* = 0x10
  DRF* = 0x12
  CDI* = 0x50
  TCON* = 0x60
  TRES* = 0x61
  AN_TM* = 0x74
  AGID* = 0x86
  BUCK_BOOST_VDDN* = 0xB0
  TFT_VCOM_POWER* = 0xB1
  EN_BUF* = 0xB6
  BOOST_VDDP_EN* = 0xB7
  CCSET* = 0xE0
  PWS* = 0xE3
  CMD66* = 0xF0

proc EPD_13IN3E_Init*() {.importc: "EPD_13IN3E_Init".}
proc EPD_13IN3E_Clear*(color: UBYTE) {.importc: "EPD_13IN3E_Clear".}
proc EPD_13IN3E_Show7Block*() {.importc: "EPD_13IN3E_Show7Block".}
proc EPD_13IN3E_Display*(Image: ptr UBYTE) {.importc: "EPD_13IN3E_Display".}
proc EPD_13IN3E_Sleep*() {.importc: "EPD_13IN3E_Sleep".}
