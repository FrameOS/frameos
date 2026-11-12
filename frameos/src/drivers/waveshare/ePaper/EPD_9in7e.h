/*****************************************************************************
* | File      	:	EPD_9in7.h
* | Author      :   Waveshare team
* | Function    :   Electronic paper driver
* | Info        :
*----------------
* |	This version:   V1.0
* | Date        :   2026-06-17
* | Info        :
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to  whom the Software is
# furished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
#
******************************************************************************/
#ifndef _EPD_9IN7E_H_
#define _EPD_9IN7E_H_

#include "DEV_Config.h"

// EL097TF1 9.7" panel, BS1 = 0 and BS0 = 1 (4-wire SPI), 1120 x 784.
#define EPD_9IN7E_WIDTH        1120
#define EPD_9IN7E_HEIGHT       784
#define EPD_9IN7E_IMAGE_BYTES  (EPD_9IN7E_WIDTH * EPD_9IN7E_HEIGHT / 2)


#define EPD_9IN7E_BLACK        0x0
#define EPD_9IN7E_WHITE        0x1
#define EPD_9IN7E_YELLOW       0x2
#define EPD_9IN7E_RED          0x3
#define EPD_9IN7E_BLUE         0x5
#define EPD_9IN7E_GREEN        0x6


void EPD_9IN7E_Init(void);
void EPD_9IN7E_Clear(UBYTE color);
void EPD_9IN7E_Display(const UBYTE *Image);
void EPD_9IN7E_DisplayPart(const UBYTE *Image, UWORD xstart, UWORD ystart, UWORD image_width, UWORD image_heigh);
void EPD_9IN7E_Sleep(void);

#endif
