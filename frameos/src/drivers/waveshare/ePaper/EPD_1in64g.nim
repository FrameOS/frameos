{.compile: "EPD_1in64g.c".}
## ***************************************************************************
##  | File      	:   EPD_1in64g.h
##  | Author      :   Waveshare team
##  | Function    :   1.64inch e-paper(G)
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2022-07-14
##  | Info        :
##  -----------------------------------------------------------------------------
## ****************************************************************************

import
  DEV_Config

const
  EPD_1IN64G_WIDTH* = 168
  EPD_1IN64G_HEIGHT* = 168
  EPD_1IN64G_BLACK* = 0x0
  EPD_1IN64G_WHITE* = 0x1
  EPD_1IN64G_YELLOW* = 0x2
  EPD_1IN64G_RED* = 0x3

proc EPD_1IN64G_Init*() {.importc: "EPD_1IN64G_Init".}
proc EPD_1IN64G_Clear*(color: UBYTE) {.importc: "EPD_1IN64G_Clear".}
proc EPD_1IN64G_Display*(Image: ptr UBYTE) {.importc: "EPD_1IN64G_Display".}
proc EPD_1IN64G_Sleep*() {.importc: "EPD_1IN64G_Sleep".}