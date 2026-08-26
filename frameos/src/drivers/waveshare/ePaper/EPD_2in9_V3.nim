{.compile: "EPD_2in9_V3.c".}
## ***************************************************************************
##  | File      	:	EPD_2in9_V3.h
##  | Author      :   Waveshare team
##  | Function    :   2.9inch e-paper V3
##  | Info        :
## ----------------
##  |	This version:   V1.0
##  | Date        :   2026-07-28
##  | Info        :
## ****************************************************************************

import
  DEV_Config

const
  EPD_2IN9_V3_WIDTH* = 128
  EPD_2IN9_V3_HEIGHT* = 296

proc EPD_2IN9_V3_Init*() {.importc: "EPD_2IN9_V3_Init".}
proc EPD_2IN9_V3_Init_Fast*() {.importc: "EPD_2IN9_V3_Init_Fast".}
proc EPD_2IN9_V3_Gray4_Init*() {.importc: "EPD_2IN9_V3_Gray4_Init".}
proc EPD_2IN9_V3_Clear*() {.importc: "EPD_2IN9_V3_Clear".}
proc EPD_2IN9_V3_Display*(Image: ptr UBYTE) {.importc: "EPD_2IN9_V3_Display".}
proc EPD_2IN9_V3_Display_Fast*(Image: ptr UBYTE) {.importc: "EPD_2IN9_V3_Display_Fast".}
proc EPD_2IN9_V3_Display_Base*(Image: ptr UBYTE) {.importc: "EPD_2IN9_V3_Display_Base".}
proc EPD_2IN9_V3_4GrayDisplay*(Image: ptr UBYTE) {.importc: "EPD_2IN9_V3_4GrayDisplay".}
proc EPD_2IN9_V3_Display_Partial*(Image: ptr UBYTE; Xstart: UWORD; Ystart: UWORD;
                                  Xend: UWORD; Yend: UWORD) {.
    importc: "EPD_2IN9_V3_Display_Partial".}
proc EPD_2IN9_V3_Sleep*() {.importc: "EPD_2IN9_V3_Sleep".}
