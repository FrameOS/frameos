{.compile: "EPD_3in97.c".}
## SPDX-License-Identifier: GPL-3.0-or-later
## ***************************************************************************
##  | File      	:   EPD_3in97.nim
##  | Function    :   3.97inch e-paper — the Good Display GDEM0397T81P panel
##  |                 used by the Seeed reTerminal Sticky.
##  | Info        :   SSD16xx-class controller (SSD1677 family), 800x480 mono.
##  |
##  | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
##  | register init sequence is derived from the EP397_800x480 support in
##  | the bb_epaper library, https://github.com/bitbank2/bb_epaper,
##  | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
##  | licensed GPL-3.0-or-later. The wrapper follows the Waveshare reference
##  | wrappers in this directory (EPD_4in26.nim).
## ----------------
##  |	This version:   V1.0
##  | Date        :   2026-08-06
## ****************************************************************************

import
  DEV_Config

const
  EPD_3in97_WIDTH* = 800
  EPD_3in97_HEIGHT* = 480

proc EPD_3in97_Init*() {.importc: "EPD_3in97_Init".}
proc EPD_3in97_Clear*() {.importc: "EPD_3in97_Clear".}
proc EPD_3in97_Display*(Image: ptr UBYTE) {.importc: "EPD_3in97_Display".}
proc EPD_3in97_Sleep*() {.importc: "EPD_3in97_Sleep".}
