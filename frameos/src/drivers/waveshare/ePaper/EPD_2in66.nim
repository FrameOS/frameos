{.compile: "EPD_2in66.c".}
## ***************************************************************************
##  | File      	:   EPD_2in66.h
##  | Author      :   Waveshare team
##  | Function    :   2.66inch e-paper
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2020-07-21
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
## #
## ****************************************************************************

import
  DEV_Config

const
  EPD_2IN66_WIDTH* = 152
  EPD_2IN66_HEIGHT* = 296

proc EPD_2IN66_Init*() {.importc: "EPD_2IN66_Init".}
proc EPD_2IN66_Display*(Image: ptr UBYTE) {.importc: "EPD_2IN66_Display".}
proc EPD_2IN66_Clear*() {.importc: "EPD_2IN66_Clear".}
proc EPD_2IN66_Init_partial*() {.importc: "EPD_2IN66_Init_partial".}
proc EPD_2IN66_Sleep*() {.importc: "EPD_2IN66_Sleep".}