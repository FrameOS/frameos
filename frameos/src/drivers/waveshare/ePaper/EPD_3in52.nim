{.compile: "EPD_3in52.c".}
## ***************************************************************************
##  | File      	:   EPD_3IN52.h
##  | Author      :   Waveshare team
##  | Function    :   3.52inch e-paper
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2022-05-07
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
  EPD_3IN52_WIDTH* = 240
  EPD_3IN52_HEIGHT* = 360
  LUTGC_TEST* = true
  LUTDU_TEST* = true
  EPD_3IN52_WHITE* = 0xFF
  EPD_3IN52_BLACK* = 0x00
  EPD_3IN52_Source_Line* = 0xAA
  EPD_3IN52_Gate_Line* = 0x55
  EPD_3IN52_UP_BLACK_DOWN_WHITE* = 0xF0
  EPD_3IN52_LEFT_BLACK_RIGHT_WHITE* = 0x0F
  EPD_3IN52_Frame* = 0x01
  EPD_3IN52_Crosstalk* = 0x02
  EPD_3IN52_Chessboard* = 0x03
  EPD_3IN52_Image* = 0x04

var EPD_3IN52_Flag*: cuchar

proc EPD_3IN52_SendCommand*(Reg: UBYTE) {.importc: "EPD_3IN52_SendCommand".}
proc EPD_3IN52_SendData*(Data: UBYTE) {.importc: "EPD_3IN52_SendData".}
proc EPD_3IN52_refresh*() {.importc: "EPD_3IN52_refresh".}
proc EPD_3IN52_lut_GC*() {.importc: "EPD_3IN52_lut_GC".}
proc EPD_3IN52_lut_DU*() {.importc: "EPD_3IN52_lut_DU".}
proc EPD_3IN52_Init*() {.importc: "EPD_3IN52_Init".}
proc EPD_3IN52_display*(picData: ptr UBYTE) {.importc: "EPD_3IN52_display".}
proc EPD_3IN52_display_NUM*(NUM: UBYTE) {.importc: "EPD_3IN52_display_NUM".}
proc EPD_3IN52_Clear*() {.importc: "EPD_3IN52_Clear".}
proc EPD_3IN52_sleep*() {.importc: "EPD_3IN52_sleep".}