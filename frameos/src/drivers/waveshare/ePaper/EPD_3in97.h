// SPDX-License-Identifier: GPL-3.0-or-later
/*****************************************************************************
* | File      	:   EPD_3in97.h
* | Function    :   3.97inch e-paper — the Good Display GDEM0397T81P panel
* |                 used by the Seeed reTerminal Sticky.
* | Info        :   SSD16xx-class controller (SSD1677 family), 800x480 mono.
* |
* | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
* | register init sequence is derived from the EP397_800x480 support in the
* | bb_epaper library, https://github.com/bitbank2/bb_epaper,
* | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
* | licensed GPL-3.0-or-later. The driver structure follows the Waveshare
* | reference drivers in this directory (EPD_4in26.h).
*----------------
* |	This version:   V1.0
* | Date        :   2026-08-06
******************************************************************************/
#ifndef __EPD_3IN97_H_
#define __EPD_3IN97_H_

#include "DEV_Config.h"


#define EPD_3in97_WIDTH       800
#define EPD_3in97_HEIGHT      480

void EPD_3in97_Init(void);
void EPD_3in97_Clear(void);
void EPD_3in97_Display(UBYTE *Image);
void EPD_3in97_Sleep(void);

#endif
