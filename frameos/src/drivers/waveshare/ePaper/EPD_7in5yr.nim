{.compile: "EPD_7in5yr.c".}
## SPDX-License-Identifier: GPL-3.0-or-later
## ***************************************************************************
##  | File      	:   EPD_7in5yr.nim
##  | Function    :   7.5inch e-paper black/white/yellow/red — the Good
##  |                 Display GDEM075F52 panel used by the TRMNL BWRY.
##  | Info        :   UC81xx-class controller, 800x480, 2 bits per pixel.
##  |
##  | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
##  | register init sequence is derived from the EP75YR_800x480 support in
##  | the bb_epaper library, https://github.com/bitbank2/bb_epaper,
##  | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
##  | licensed GPL-3.0-or-later. The wrapper follows the Waveshare reference
##  | wrappers in this directory (EPD_7in3g.nim).
## ----------------
##  |	This version:   V1.0
##  | Date        :   2026-08-06
## ****************************************************************************

import
  DEV_Config

const
  EPD_7IN5YR_WIDTH* = 800
  EPD_7IN5YR_HEIGHT* = 480
  EPD_7IN5YR_BLACK* = 0x0
  EPD_7IN5YR_WHITE* = 0x1
  EPD_7IN5YR_YELLOW* = 0x2
  EPD_7IN5YR_RED* = 0x3

proc EPD_7IN5YR_Init*() {.importc: "EPD_7IN5YR_Init".}
proc EPD_7IN5YR_Clear*(color: UBYTE) {.importc: "EPD_7IN5YR_Clear".}
proc EPD_7IN5YR_Display*(Image: ptr UBYTE) {.importc: "EPD_7IN5YR_Display".}
proc EPD_7IN5YR_Sleep*() {.importc: "EPD_7IN5YR_Sleep".}
