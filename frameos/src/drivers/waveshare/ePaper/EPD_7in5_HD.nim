{.compile: "EPD_7in5_HD.c".}
## ***************************************************************************
##  | File      	:	EPD_7in5_HD.h
##  | Author      :   Waveshare team
##  | Function    :   Electronic paper driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2020-04-25
##  | Info        :
## ****************************************************************************
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
  EPD_7IN5_HD_WIDTH* = 880
  EPD_7IN5_HD_HEIGHT* = 528

proc EPD_7IN5_HD_Init*() {.importc: "EPD_7IN5_HD_Init".}
proc EPD_7IN5_HD_Clear*() {.importc: "EPD_7IN5_HD_Clear".}
proc EPD_7IN5_HD_ClearBlack*() {.importc: "EPD_7IN5_HD_ClearBlack".}
proc EPD_7IN5_HD_Display*(blackimage: ptr UBYTE) {.importc: "EPD_7IN5_HD_Display".}
proc EPD_7IN5_HD_Sleep*() {.importc: "EPD_7IN5_HD_Sleep".}