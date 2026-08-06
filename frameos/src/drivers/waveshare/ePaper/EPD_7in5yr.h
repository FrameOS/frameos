// SPDX-License-Identifier: GPL-3.0-or-later
/*****************************************************************************
* | File      	:   EPD_7in5yr.h
* | Function    :   7.5inch e-paper black/white/yellow/red — the Good Display
* |                 GDEM075F52 panel used by the TRMNL BWRY.
* | Info        :   UC81xx-class controller, 800x480, 2 bits per pixel.
* |
* | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
* | register init sequence is derived from the EP75YR_800x480 support in the
* | bb_epaper library, https://github.com/bitbank2/bb_epaper,
* | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
* | licensed GPL-3.0-or-later. The driver structure follows the Waveshare
* | reference drivers in this directory (EPD_7in3g.h).
*----------------
* |	This version:   V1.0
* | Date        :   2026-08-06
******************************************************************************/
#ifndef __EPD_7IN5YR_H_
#define __EPD_7IN5YR_H_

#include "DEV_Config.h"


#define EPD_7IN5YR_WIDTH       800
#define EPD_7IN5YR_HEIGHT      480


#define  EPD_7IN5YR_BLACK   0x0
#define  EPD_7IN5YR_WHITE   0x1
#define  EPD_7IN5YR_YELLOW  0x2
#define  EPD_7IN5YR_RED     0x3

void EPD_7IN5YR_Init(void);
void EPD_7IN5YR_Clear(UBYTE color);
void EPD_7IN5YR_Display(UBYTE *Image);
void EPD_7IN5YR_Sleep(void);

#endif
