{.compile: "EPD_13in3e.c".}
## ***************************************************************************
##  | File      	:	EPD_13in3e.h
##  | Author      :   Waveshare team
##  | Function    :   13.3inch e-Paper (E) Driver
##  | Info        :   FrameOS-maintained fork (dual chip select, busy
##  |                 timeouts, T133A01 panel variant); see README.md
## ----------------
##  |	This version:   V1.0
##  | Date        :   2018-11-29
## ****************************************************************************

import
  DEV_Config

const
  EPD_13IN3E_WIDTH* = 1200
  EPD_13IN3E_HEIGHT* = 1600

const
  EPD_13IN3E_BLACK* = 0x0
  EPD_13IN3E_WHITE* = 0x1
  EPD_13IN3E_YELLOW* = 0x2
  EPD_13IN3E_RED* = 0x3
  EPD_13IN3E_BLUE* = 0x5
  EPD_13IN3E_GREEN* = 0x6

const
  EPD_13IN3E_VARIANT_WAVESHARE* = 0
  EPD_13IN3E_VARIANT_T133A01* = 1

proc EPD_13IN3E_SetVariant*(variant: cint) {.importc: "EPD_13IN3E_SetVariant".}
proc EPD_13IN3E_GetVariant*(): cint {.importc: "EPD_13IN3E_GetVariant".}
proc EPD_13IN3E_Init*() {.importc: "EPD_13IN3E_Init".}
proc EPD_13IN3E_Clear*(color: UBYTE) {.importc: "EPD_13IN3E_Clear".}
proc EPD_13IN3E_Display*(Image: ptr UBYTE) {.importc: "EPD_13IN3E_Display".}
proc EPD_13IN3E_DisplayPart*(Image: ptr UBYTE; xstart: UWORD; ystart: UWORD;
                             image_width: UWORD; image_heigh: UWORD) {.
    importc: "EPD_13IN3E_DisplayPart".}
proc EPD_13IN3E_Show6Block*() {.importc: "EPD_13IN3E_Show6Block".}
proc EPD_13IN3E_Sleep*() {.importc: "EPD_13IN3E_Sleep".}
