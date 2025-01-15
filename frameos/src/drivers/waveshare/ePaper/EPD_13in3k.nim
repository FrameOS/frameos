{.compile: "EPD_13in3k.c".}
## ***************************************************************************
##  | File      	:   EPD_13in3K.h
##  | Author      :   Waveshare team
##  | Function    :   13.3inch e-paper (K)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-07-18
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
  EPD_13IN3K_WIDTH* = 960
  EPD_13IN3K_HEIGHT* = 680

proc EPD_13IN3K_Init*() {.importc: "EPD_13IN3K_Init".}
proc EPD_13IN3K_Init_Part*() {.importc: "EPD_13IN3K_Init_Part".}
proc EPD_13IN3K_Init_4GRAY*() {.importc: "EPD_13IN3K_Init_4GRAY".}
proc EPD_13IN3K_Clear*() {.importc: "EPD_13IN3K_Clear".}
proc EPD_13IN3K_color_Base*(color: UBYTE) {.importc: "EPD_13IN3K_color_Base".}
proc EPD_13IN3K_Display*(Image: ptr UBYTE) {.importc: "EPD_13IN3K_Display".}
proc EPD_13IN3K_Display_Base*(Image: ptr UBYTE) {.importc: "EPD_13IN3K_Display_Base".}
proc EPD_13IN3K_Display_Part*(Image: ptr UBYTE; x: UWORD; y: UWORD; w: UWORD; l: UWORD) {.
    importc: "EPD_13IN3K_Display_Part".}
proc EPD_13IN3K_4GrayDisplay*(Image: ptr UBYTE) {.importc: "EPD_13IN3K_4GrayDisplay".}
proc EPD_13IN3K_Sleep*() {.importc: "EPD_13IN3K_Sleep".}