{.compile: "EPD_2in15b.c".}
## ***************************************************************************
##  | File      	:   EPD_2in15b.h
##  | Author      :   Waveshare team
##  | Function    :   2.15inch e-paper b
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2024-08-07
##  | Info        :
##  -----------------------------------------------------------------------------
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
## # z*

import
  DEV_Config

const
  EPD_2IN15B_WIDTH* = 160
  EPD_2IN15B_HEIGHT* = 296

proc EPD_2IN15B_Init*() {.importc: "EPD_2IN15B_Init".}
proc EPD_2IN15B_Display*(ImageBlack: ptr UBYTE; ImageRed: ptr UBYTE) {.
    importc: "EPD_2IN15B_Display".}
proc EPD_2IN15B_Clear*() {.importc: "EPD_2IN15B_Clear".}
proc EPD_2IN15B_Clear_Black*() {.importc: "EPD_2IN15B_Clear_Black".}
proc EPD_2IN15B_Clear_Red*() {.importc: "EPD_2IN15B_Clear_Red".}
proc EPD_2IN15B_Sleep*() {.importc: "EPD_2IN15B_Sleep".}