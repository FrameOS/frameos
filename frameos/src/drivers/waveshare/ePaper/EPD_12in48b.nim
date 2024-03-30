{.compile: "EPD_12in48b.c".}
## ***************************************************************************
##  | File      	:	EPD_12in48b.h
##  | Author      :   Waveshare team
##  | Function    :   Electronic paper driver
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2018-11-29
##  | Info        :
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
  EPD_12in48B_MAX_WIDTH* = 1304
  EPD_12in48B_MAX_HEIGHT* = 984
  EPD_12in48B_M1_WIDTH* = 648
  EPD_12in48B_M1_HEIGHT* = (EPD_MAX_HEIGHT div 2)
  EPD_12in48B_S1_WIDTH* = (EPD_12in48B_MAX_WIDTH - 648)
  EPD_12in48B_S1_HEIGHT* = (EPD_MAX_HEIGHT div 2)
  EPD_12in48B_M2_WIDTH* = (EPD_12in48B_MAX_WIDTH - 648)
  EPD_12in48B_M2_HEIGHT* = (EPD_MAX_HEIGHT div 2)
  EPD_12in48B_S2_WIDTH* = 648
  EPD_12in48B_S2_HEIGHT* = (EPD_MAX_HEIGHT div 2)

proc EPD_12in48B_Init*(): UBYTE {.importc: "EPD_12in48B_Init".}
proc EPD_12in48B_Clear*() {.importc: "EPD_12in48B_Clear".}
proc EPD_12in48B_Display*(BlackImage: ptr UBYTE; RedImage: ptr UBYTE) {.
    importc: "EPD_12in48B_Display".}
proc EPD_12in48B_TurnOnDisplay*() {.importc: "EPD_12in48B_TurnOnDisplay".}
proc EPD_12in48B_Sleep*() {.importc: "EPD_12in48B_Sleep".}