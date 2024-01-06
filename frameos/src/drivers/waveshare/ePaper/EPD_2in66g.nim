{.compile: "EPD_2in66g.c".}
## ***************************************************************************
##  | File      	:   EPD_2in66g.h
##  | Author      :   Waveshare team
##  | Function    :   2.66inch e-Paper (G)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-12-20
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
  EPD_2IN66g_WIDTH* = 184
  EPD_2IN66g_HEIGHT* = 360
  EPD_2IN66g_BLACK* = 0x0
  EPD_2IN66g_WHITE* = 0x1
  EPD_2IN66g_YELLOW* = 0x2
  EPD_2IN66g_RED* = 0x3

proc EPD_2IN66g_Init*() {.importc: "EPD_2IN66g_Init".}
proc EPD_2IN66g_Clear*(color: UBYTE) {.importc: "EPD_2IN66g_Clear".}
proc EPD_2IN66g_Display*(Image: ptr UBYTE) {.importc: "EPD_2IN66g_Display".}
proc EPD_2IN66g_Sleep*() {.importc: "EPD_2IN66g_Sleep".}