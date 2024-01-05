{.compile: "EPD_4in26.c".}
## ***************************************************************************
##  | File      	:   EPD_4in26.h
##  | Author      :   Waveshare team
##  | Function    :   4.26inch e-paper test demo
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-12-19
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
  EPD_4in26_WIDTH* = 800
  EPD_4in26_HEIGHT* = 480

proc EPD_4in26_Init*() {.importc: "EPD_4in26_Init".}
proc EPD_4in26_Init_Fast*() {.importc: "EPD_4in26_Init_Fast".}
proc EPD_4in26_Init_4GRAY*() {.importc: "EPD_4in26_Init_4GRAY".}
proc EPD_4in26_Clear*() {.importc: "EPD_4in26_Clear".}
proc EPD_4in26_Display*(Image: ptr UBYTE) {.importc: "EPD_4in26_Display".}
proc EPD_4in26_Display_Base*(Image: ptr UBYTE) {.importc: "EPD_4in26_Display_Base".}
proc EPD_4in26_Display_Fast*(Image: ptr UBYTE) {.importc: "EPD_4in26_Display_Fast".}
proc EPD_4in26_Display_Part*(Image: ptr UBYTE; x: UWORD; y: UWORD; w: UWORD; l: UWORD) {.
    importc: "EPD_4in26_Display_Part".}
proc EPD_4in26_4GrayDisplay*(Image: ptr UBYTE) {.importc: "EPD_4in26_4GrayDisplay".}
proc EPD_4in26_Sleep*() {.importc: "EPD_4in26_Sleep".}