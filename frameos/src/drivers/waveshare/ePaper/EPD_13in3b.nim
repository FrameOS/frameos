{.compile: "EPD_13in3b.c".}
## ***************************************************************************
##  | File      	:   EPD_13in3b.h
##  | Author      :   Waveshare team
##  | Function    :   13.3inch e-paper (B)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2024-04-08
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
  EPD_13IN3B_WIDTH* = 960
  EPD_13IN3B_HEIGHT* = 680

proc EPD_13IN3B_Init*() {.importc: "EPD_13IN3B_Init".}
proc EPD_13IN3B_Clear*() {.importc: "EPD_13IN3B_Clear".}
proc EPD_13IN3B_Clear_Black*() {.importc: "EPD_13IN3B_Clear_Black".}
proc EPD_13IN3B_Clear_Red*() {.importc: "EPD_13IN3B_Clear_Red".}
proc EPD_13IN3B_Display*(blackimage: ptr UBYTE; ryimage: ptr UBYTE) {.
    importc: "EPD_13IN3B_Display".}
proc EPD_13IN3B_Display_Base*(blackimage: ptr UBYTE; ryimage: ptr UBYTE) {.
    importc: "EPD_13IN3B_Display_Base".}
proc EPD_13IN3B_Display_Base_White*() {.importc: "EPD_13IN3B_Display_Base_White".}
proc EPD_13IN3B_Display_Partial*(Image: ptr UBYTE; Xstart: UWORD; Ystart: UWORD;
                                Xend: UWORD; Yend: UWORD) {.
    importc: "EPD_13IN3B_Display_Partial".}
proc EPD_13IN3B_Sleep*() {.importc: "EPD_13IN3B_Sleep".}