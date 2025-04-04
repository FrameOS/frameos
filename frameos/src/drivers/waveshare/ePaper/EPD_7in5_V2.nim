{.compile: "EPD_7in5_V2.c".}
## ***************************************************************************
##  | File      	:	EPD_7in5_V2.h
##  | Author      :   Waveshare team
##  | Function    :   Electronic paper driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-12-18
##  | Info        :
##  1.Remove:ImageBuff[EPD_HEIGHT * EPD_WIDTH / 8]
##  2.Change:EPD_Display(UBYTE *Image)
##    Need to pass parameters: pointer to cached data
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
  EPD_7IN5_V2_WIDTH* = 800
  EPD_7IN5_V2_HEIGHT* = 480

proc EPD_7IN5_V2_Init*(): UBYTE {.importc: "EPD_7IN5_V2_Init".}
proc EPD_7IN5_V2_Init_Fast*(): UBYTE {.importc: "EPD_7IN5_V2_Init_Fast".}
proc EPD_7IN5_V2_Init_Partial*(): UBYTE {.importc: "EPD_7IN5_V2_Init_Partial".}
proc EPD_7IN5_V2_Clear*() {.importc: "EPD_7IN5_V2_Clear".}
proc EPD_7IN5_V2_ClearBlack*() {.importc: "EPD_7IN5_V2_ClearBlack".}
proc EPD_7IN5_V2_Display*(blackimage: ptr UBYTE) {.importc: "EPD_7IN5_V2_Display".}
proc EPD_7IN5_V2_Display_Partial*(blackimage: ptr UBYTE; x_start: UDOUBLE;
                                 y_start: UDOUBLE; x_end: UDOUBLE; y_end: UDOUBLE) {.
    importc: "EPD_7IN5_V2_Display_Partial".}
proc EPD_7IN5_V2_Sleep*() {.importc: "EPD_7IN5_V2_Sleep".}