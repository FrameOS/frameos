{.compile: "EPD_7in3e.c".}
## ***************************************************************************
##  | File        :   EPD_7in3e.h
##  | Author      :   Waveshare team
##  | Function    :   7.3inch e-Paper (F) Driver
##  | Info        :
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

proc EPD_7IN3E_Init*() {.importc: "EPD_7IN3E_Init".}
proc EPD_7IN3E_Init_Fast*() {.importc: "EPD_7IN3E_Init_Fast".}
proc EPD_7IN3E_Clear*(color: UBYTE) {.importc: "EPD_7IN3E_Clear".}
proc EPD_7IN3E_Show7Block*() {.importc: "EPD_7IN3E_Show7Block".}
proc EPD_7IN3E_Show*() {.importc: "EPD_7IN3E_Show".}
proc EPD_7IN3E_Display*(Image: ptr UBYTE) {.importc: "EPD_7IN3E_Display".}
proc EPD_7IN3E_Sleep*() {.importc: "EPD_7IN3E_Sleep".}