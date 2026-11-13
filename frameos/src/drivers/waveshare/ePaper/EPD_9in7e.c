/*****************************************************************************
* | File        :   EPD_9in7.c
* | Author      :   Waveshare team
* | Function    :   Electronic paper driver
* | Info     :
*----------------
* | This version:   V1.0
* | Date     :   2026-06-17
* | Info     :
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files(the "Software"), to deal
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
#include "EPD_9in7e.h"
#include "Debug.h"
#include <string.h>

/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_9IN7E_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_9IN7E_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_DC_PIN, 0);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :	send data
parameter:
    Data : Write data
******************************************************************************/
static void EPD_9IN7E_SendData(UBYTE Reg)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}
static void EPD_9IN7E_SendData2(const UBYTE *buf, uint32_t Len)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Write_nByte((UBYTE *)buf, Len);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :	Wait until the busy_pin goes LOW
parameter:
******************************************************************************/
static void EPD_9IN7E_ReadBusyH(void)
{
    Debug("e-Paper busy\r\n");
    UDOUBLE busy_wait_ms = 0;
	while(!DEV_Digital_Read(EPD_BUSY_PIN)) {      //LOW: busy, HIGH: idle
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            break;
        }
        DEV_Delay_ms(10);
        busy_wait_ms += 10;
        // Debug("e-Paper busy release\r\n");
    }
	DEV_Delay_ms(20);
    Debug("e-Paper busy release\r\n");
}


/******************************************************************************
function :  Turn On Display
parameter:
******************************************************************************/
static void EPD_9IN7E_TurnOnDisplay(void)
{
    Debug("Write PON \r\n");
    EPD_9IN7E_SendCommand(0x04);
    EPD_9IN7E_ReadBusyH();

    Debug("Write DRF \r\n");
    DEV_Delay_ms(30);
    EPD_9IN7E_SendCommand(0x12);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_ReadBusyH();

    Debug("Write POF \r\n");
    EPD_9IN7E_SendCommand(0x02);
    EPD_9IN7E_SendData(0x01);
    EPD_9IN7E_ReadBusyH();
    Debug("Display Done!! \r\n");
}

/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_9IN7E_Init(void)
{
    EPD_9IN7E_Reset();
    EPD_9IN7E_ReadBusyH();

    EPD_9IN7E_SendCommand(0x74);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0x0C);
    EPD_9IN7E_SendData(0x0C);
    EPD_9IN7E_SendData(0xD9);
    EPD_9IN7E_SendData(0xDD);
    EPD_9IN7E_SendData(0xDD);
    EPD_9IN7E_SendData(0x15);
    EPD_9IN7E_SendData(0x15);
    EPD_9IN7E_SendData(0x55);

    EPD_9IN7E_SendCommand(0xF0);
    EPD_9IN7E_SendData(0x49);
    EPD_9IN7E_SendData(0x55);
    EPD_9IN7E_SendData(0x13);
    EPD_9IN7E_SendData(0x5D);
    EPD_9IN7E_SendData(0x05);
    EPD_9IN7E_SendData(0x10);

    EPD_9IN7E_SendCommand(0xA4);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0x01);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0x00);

    EPD_9IN7E_SendCommand(0x00);
    EPD_9IN7E_SendData(0xDF);
    EPD_9IN7E_SendData(0x6B);

    EPD_9IN7E_SendCommand(0xA5);
    EPD_9IN7E_SendData(0x44);
    EPD_9IN7E_SendData(0x54);
    EPD_9IN7E_SendData(0x00);

    EPD_9IN7E_SendCommand(0x30);
    EPD_9IN7E_SendData(0x08);

    EPD_9IN7E_SendCommand(0x50);
    EPD_9IN7E_SendData(0x37);

    EPD_9IN7E_SendCommand(0x60);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0x03);

    EPD_9IN7E_SendCommand(0x03);
    EPD_9IN7E_SendData(0x00);
    EPD_9IN7E_SendData(0xC0);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0xA8);

    EPD_9IN7E_SendCommand(0x86);
    EPD_9IN7E_SendData(0x00);

    EPD_9IN7E_SendCommand(0xE3);
    EPD_9IN7E_SendData(0x22);

    EPD_9IN7E_SendCommand(0xE0);
    EPD_9IN7E_SendData(0x00);

    EPD_9IN7E_SendCommand(0x61);
    EPD_9IN7E_SendData(0x04);
    EPD_9IN7E_SendData(0x60);
    EPD_9IN7E_SendData(0x03);
    EPD_9IN7E_SendData(0x10);

    EPD_9IN7E_SendCommand(0x01);
    EPD_9IN7E_SendData(0x0F);
    EPD_9IN7E_SendData(0x02);
    EPD_9IN7E_SendData(0x28);
    EPD_9IN7E_SendData(0x30);
    EPD_9IN7E_SendData(0x28);
    EPD_9IN7E_SendData(0x42);

    EPD_9IN7E_SendCommand(0xE7);
    EPD_9IN7E_SendData(0x01);

    EPD_9IN7E_SendCommand(0xB6);
    EPD_9IN7E_SendData(0x07);

    EPD_9IN7E_SendCommand(0x06);
    EPD_9IN7E_SendData(0xD0);
    EPD_9IN7E_SendData(0x18);

    EPD_9IN7E_SendCommand(0xB7);
    EPD_9IN7E_SendData(0x01);

    EPD_9IN7E_SendCommand(0x05);
    EPD_9IN7E_SendData(0xD0);
    EPD_9IN7E_SendData(0x18);

    EPD_9IN7E_SendCommand(0xB0);
    EPD_9IN7E_SendData(0x01);

    EPD_9IN7E_SendCommand(0xB1);
    EPD_9IN7E_SendData(0x02);
}

/******************************************************************************
function :  Clear screen
parameter:
******************************************************************************/
void EPD_9IN7E_Clear(UBYTE color)
{
    UDOUBLE Width, Height;
    UBYTE Color;
    Width = (EPD_9IN7E_WIDTH % 2 == 0)? (EPD_9IN7E_WIDTH / 2 ): (EPD_9IN7E_WIDTH / 2 + 1);
    Height = EPD_9IN7E_HEIGHT;
    Color = (color << 4) | color;
    
    UBYTE buf[Width];
    
    for (UDOUBLE j = 0; j < Width; j++) {
        buf[j] = Color;
    }

    EPD_9IN7E_SendCommand(0x10);
    for (UDOUBLE j = 0; j < EPD_9IN7E_HEIGHT; j++) {
        EPD_9IN7E_SendData2(buf, Width);
        DEV_Delay_ms(1);
    }
    
    EPD_9IN7E_TurnOnDisplay();
}

void EPD_9IN7E_Display(const UBYTE *Image)
{
    EPD_9IN7E_SendCommand(0x10);
    EPD_9IN7E_SendData2(Image, EPD_9IN7E_IMAGE_BYTES);

    EPD_9IN7E_TurnOnDisplay();
}

void EPD_9IN7E_DisplayPart(const UBYTE *Image, UWORD xstart, UWORD ystart, UWORD image_width, UWORD image_heigh)
{
	unsigned long i, j;
	UWORD Width, Height;
	Width = (EPD_9IN7E_WIDTH % 2 == 0)? (EPD_9IN7E_WIDTH / 2 ): (EPD_9IN7E_WIDTH / 2 + 1);
	Height = EPD_9IN7E_HEIGHT;
    EPD_9IN7E_SendCommand(0x10);
	for(i=0; i<Height; i++) {
		for(j=0; j<Width; j++) {
			if(i<image_heigh+ystart && i>=ystart && j<(image_width+xstart)/2 && j>=xstart/2) {
				EPD_9IN7E_SendData(Image[(j-xstart/2) + (image_width/2*(i-ystart))]);
			}
			else {
				EPD_9IN7E_SendData(0x11);
			}
		}
	}
	EPD_9IN7E_TurnOnDisplay();
}


/******************************************************************************
function :  Enter sleep mode
parameter:
******************************************************************************/
void EPD_9IN7E_Sleep(void)
{
    EPD_9IN7E_SendCommand(0x02);
    EPD_9IN7E_SendData(0x01);
    EPD_9IN7E_ReadBusyH();
}





