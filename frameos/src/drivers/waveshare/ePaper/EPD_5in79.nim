{.compile: "EPD_5in79.c".}
## ***************************************************************************
##  | File      	:	EPD_5in79.h
##  | Author      :   Waveshare team
##  | Function    :   Electronic paper driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2024-03-05
##  | Info        :
## *****************************************************************************
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
  EPD_5in79_WIDTH* = 792
  EPD_5in79_HEIGHT* = 272

proc EPD_5in79_Init*(): UBYTE {.importc: "EPD_5in79_Init".}
proc EPD_5in79_Init_Fast*(): UBYTE {.importc: "EPD_5in79_Init_Fast".}
proc EPD_5in79_Init_Partial*(): UBYTE {.importc: "EPD_5in79_Init_Partial".}
proc EPD_5in79_Init_4Gray*(): UBYTE {.importc: "EPD_5in79_Init_4Gray".}
proc EPD_5in79_Clear*() {.importc: "EPD_5in79_Clear".}
proc EPD_5in79_Clear_Black*() {.importc: "EPD_5in79_Clear_Black".}
proc EPD_5in79_Display_Base_color*(color: UBYTE) {.
    importc: "EPD_5in79_Display_Base_color".}
proc EPD_5in79_Display*(Image: ptr UBYTE) {.importc: "EPD_5in79_Display".}
proc EPD_5in79_Display_Base*(Image: ptr UBYTE) {.importc: "EPD_5in79_Display_Base".}
proc EPD_5in79_Display_Fast*(Image: ptr UBYTE) {.importc: "EPD_5in79_Display_Fast".}
proc EPD_5in79_Display_Partial*(Image: ptr UBYTE; Xstart: UWORD; Ystart: UWORD;
                               Xend: UWORD; Yend: UWORD) {.
    importc: "EPD_5in79_Display_Partial".}
proc EPD_5in79_4GrayDisplay*(Image: ptr UBYTE) {.importc: "EPD_5in79_4GrayDisplay".}
proc EPD_5in79_Sleep*() {.importc: "EPD_5in79_Sleep".}