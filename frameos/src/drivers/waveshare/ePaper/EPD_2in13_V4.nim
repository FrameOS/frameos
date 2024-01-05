{.compile: "EPD_2in13_V4.c".}
## ***************************************************************************
##  | File      	:   EPD_2Iin13_V4.h
##  | Author      :   Waveshare team
##  | Function    :   2.13inch e-paper V4
##  | Info        :
## ----------------
##  |	This version:   V1.1
##  | Date        :   2021-10-30
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
  EPD_2in13_V4_WIDTH* = 122
  EPD_2in13_V4_HEIGHT* = 250

proc EPD_2in13_V4_Init*() {.importc: "EPD_2in13_V4_Init".}
proc EPD_2in13_V4_Init_Fast*() {.importc: "EPD_2in13_V4_Init_Fast".}
proc EPD_2in13_V4_Init_GUI*() {.importc: "EPD_2in13_V4_Init_GUI".}
proc EPD_2in13_V4_Clear*() {.importc: "EPD_2in13_V4_Clear".}
proc EPD_2in13_V4_Clear_Black*() {.importc: "EPD_2in13_V4_Clear_Black".}
proc EPD_2in13_V4_Display*(Image: ptr UBYTE) {.importc: "EPD_2in13_V4_Display".}
proc EPD_2in13_V4_Display_Fast*(Image: ptr UBYTE) {.
    importc: "EPD_2in13_V4_Display_Fast".}
proc EPD_2in13_V4_Display_Base*(Image: ptr UBYTE) {.
    importc: "EPD_2in13_V4_Display_Base".}
proc EPD_2in13_V4_Display_Partial*(Image: ptr UBYTE) {.
    importc: "EPD_2in13_V4_Display_Partial".}
proc EPD_2in13_V4_Sleep*() {.importc: "EPD_2in13_V4_Sleep".}