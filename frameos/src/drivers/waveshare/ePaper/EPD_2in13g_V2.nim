{.compile: "EPD_2in13g_V2.c".}
## ***************************************************************************
##  | File      	:   EPD_2in13g.h
##  | Author      :   Waveshare team
##  | Function    :   2inch13 e-paper (G)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2023-05-29
##  | Info        :
##  -----------------------------------------------------------------------------
## ****************************************************************************

import
  DEV_Config

const
  EPD_2IN13G_V2_WIDTH* = 122
  EPD_2IN13G_V2_HEIGHT* = 250
  EPD_2IN13G_V2_BLACK* = 0x0
  EPD_2IN13G_V2_WHITE* = 0x1
  EPD_2IN13G_V2_YELLOW* = 0x2
  EPD_2IN13G_V2_RED* = 0x3

proc EPD_2IN13G_V2_Init*() {.importc: "EPD_2IN13G_V2_Init".}
proc EPD_2IN13G_V2_Init_Fast*() {.importc: "EPD_2IN13G_V2_Init_Fast".}
proc EPD_2IN13G_V2_Clear*(color: UBYTE) {.importc: "EPD_2IN13G_V2_Clear".}
proc EPD_2IN13G_V2_Display*(Image: ptr UBYTE) {.importc: "EPD_2IN13G_V2_Display".}
proc EPD_2IN13G_V2_Sleep*() {.importc: "EPD_2IN13G_V2_Sleep".}