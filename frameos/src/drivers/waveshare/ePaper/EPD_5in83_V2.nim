{.compile: "EPD_5in83_V2.c".}
## ***************************************************************************
##  | File      	:   EPD_5in83_V2.h
##  | Author      :   Waveshare team
##  | Function    :   5.83inch e-paper V2
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2020-11-23
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
  EPD_5in83_V2_WIDTH* = 648
  EPD_5in83_V2_HEIGHT* = 480

proc EPD_5in83_V2_Init*() {.importc: "EPD_5in83_V2_Init".}
proc EPD_5in83_V2_Clear*() {.importc: "EPD_5in83_V2_Clear".}
proc EPD_5in83_V2_Display*(Image: ptr UBYTE) {.importc: "EPD_5in83_V2_Display".}
proc EPD_5in83_V2_Sleep*() {.importc: "EPD_5in83_V2_Sleep".}