{.compile: "EPD_5in65f.c".}
## ***************************************************************************
##  | File      	:   EPD_5in65f.h
##  | Author      :   Waveshare team
##  | Function    :   5.65inch e-paper
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2020-07-07
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

## ********************************
## Color Index
## ********************************

const
  EPD_5IN65F_BLACK* = 0x0
  EPD_5IN65F_WHITE* = 0x1
  EPD_5IN65F_GREEN* = 0x2
  EPD_5IN65F_BLUE* = 0x3
  EPD_5IN65F_RED* = 0x4
  EPD_5IN65F_YELLOW* = 0x5
  EPD_5IN65F_ORANGE* = 0x6
  EPD_5IN65F_CLEAN* = 0x7
  EPD_5IN65F_WIDTH* = 600
  EPD_5IN65F_HEIGHT* = 448

proc EPD_5IN65F_Clear*(color: UBYTE) {.importc: "EPD_5IN65F_Clear".}
proc EPD_5IN65F_Sleep*() {.importc: "EPD_5IN65F_Sleep".}
proc EPD_Init*() {.importc: "EPD_Init".}
proc EPD_5IN65F_Display*(image: ptr UBYTE) {.importc: "EPD_5IN65F_Display".}
proc EPD_5IN65F_Init*() {.importc: "EPD_5IN65F_Init".}
proc EPD_5IN65F_Display_part*(image: ptr UBYTE; xstart: UWORD; ystart: UWORD;
                             image_width: UWORD; image_heigh: UWORD) {.
    importc: "EPD_5IN65F_Display_part".}