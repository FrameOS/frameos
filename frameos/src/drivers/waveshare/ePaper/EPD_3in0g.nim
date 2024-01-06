{.compile: "EPD_3in0g.c".}
## ***************************************************************************
##  | File      	:   EPD_3in0g.h
##  | Author      :   Waveshare team
##  | Function    :   3inch e-paper (G)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2022-07-15
##  | Info        :
##  -----------------------------------------------------------------------------
## ****************************************************************************

import
  DEV_Config

const
  EPD_3IN0G_WIDTH* = 168
  EPD_3IN0G_HEIGHT* = 400
  EPD_3IN0G_BLACK* = 0x0
  EPD_3IN0G_WHITE* = 0x1
  EPD_3IN0G_YELLOW* = 0x2
  EPD_3IN0G_RED* = 0x3

proc EPD_3IN0G_Init*() {.importc: "EPD_3IN0G_Init".}
proc EPD_3IN0G_Clear*(color: UBYTE) {.importc: "EPD_3IN0G_Clear".}
proc EPD_3IN0G_Display*(Image: ptr UBYTE) {.importc: "EPD_3IN0G_Display".}
proc EPD_3IN0G_Sleep*() {.importc: "EPD_3IN0G_Sleep".}