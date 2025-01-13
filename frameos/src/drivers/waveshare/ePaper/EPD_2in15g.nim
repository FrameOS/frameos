{.compile: "EPD_2in15g.c".}
## ***************************************************************************
##  | File      	:   EPD_2in15g.h
##  | Author      :   Waveshare team
##  | Function    :   2inch15 e-paper (G)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2024-08-07
##  | Info        :
##  -----------------------------------------------------------------------------
## ****************************************************************************

import
  DEV_Config

const
  EPD_2IN15G_WIDTH* = 160
  EPD_2IN15G_HEIGHT* = 296
  EPD_2IN15G_BLACK* = 0x0
  EPD_2IN15G_WHITE* = 0x1
  EPD_2IN15G_YELLOW* = 0x2
  EPD_2IN15G_RED* = 0x3

proc EPD_2IN15G_Init*() {.importc: "EPD_2IN15G_Init".}
proc EPD_2IN15G_Clear*(color: UBYTE) {.importc: "EPD_2IN15G_Clear".}
proc EPD_2IN15G_Display*(Image: ptr UBYTE) {.importc: "EPD_2IN15G_Display".}
proc EPD_2IN15G_Sleep*() {.importc: "EPD_2IN15G_Sleep".}