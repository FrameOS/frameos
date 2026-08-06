// SPDX-License-Identifier: GPL-3.0-or-later
/*****************************************************************************
* | File      	:   EPD_3in97.c
* | Function    :   3.97inch e-paper — the Good Display GDEM0397T81P panel
* |                 used by the Seeed reTerminal Sticky.
* | Info        :   SSD16xx-class controller (SSD1677 family), 800x480 mono,
* |                 1 bit per pixel (0 black, 1 white). Same command set as
* |                 the Waveshare 4.26" (EPD_4in26).
* |
* | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
* | register init sequence is derived from the EP397_800x480 support in the
* | bb_epaper library, https://github.com/bitbank2/bb_epaper,
* | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
* | licensed GPL-3.0-or-later. The driver structure follows the Waveshare
* | reference drivers in this directory (EPD_4in26.c).
*----------------
* |	This version:   V1.0
* | Date        :   2026-08-06
******************************************************************************/
#include "EPD_3in97.h"
#include "Debug.h"

/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_3in97_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(100);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(2);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(100);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_3in97_SendCommand(UBYTE Reg)
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
static void EPD_3in97_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

static void EPD_3in97_SendData2(UBYTE *pData, UDOUBLE len)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Write_nByte(pData, len);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :	Wait until the busy_pin goes LOW (HIGH: busy, LOW: idle)
parameter:
******************************************************************************/
static void EPD_3in97_ReadBusy(void)
{
    Debug("e-Paper busy\r\n");
    UDOUBLE busy_wait_ms = 0;
    while(1)
    {
        if(DEV_Digital_Read(EPD_BUSY_PIN)==0)
            break;
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            break;
        }
        DEV_Delay_ms(20);
        busy_wait_ms += 20;
    }
    DEV_Delay_ms(20);
    Debug("e-Paper busy release\r\n");
}

/******************************************************************************
function :	Turn On Display
parameter:
******************************************************************************/
static void EPD_3in97_TurnOnDisplay(void)
{
    EPD_3in97_SendCommand(0x22); // Display Update Control
    EPD_3in97_SendData(0xF7);
    EPD_3in97_SendCommand(0x20); // Activate Display Update Sequence
    EPD_3in97_ReadBusy();
}

/******************************************************************************
function :	Setting the display window
parameter:
******************************************************************************/
static void EPD_3in97_SetWindows(UWORD Xstart, UWORD Ystart, UWORD Xend, UWORD Yend)
{
    EPD_3in97_SendCommand(0x44); // SET_RAM_X_ADDRESS_START_END_POSITION
    EPD_3in97_SendData(Xstart & 0xFF);
    EPD_3in97_SendData((Xstart>>8) & 0x03);
    EPD_3in97_SendData(Xend & 0xFF);
    EPD_3in97_SendData((Xend>>8) & 0x03);

    EPD_3in97_SendCommand(0x45); // SET_RAM_Y_ADDRESS_START_END_POSITION
    EPD_3in97_SendData(Ystart & 0xFF);
    EPD_3in97_SendData((Ystart>>8) & 0x03);
    EPD_3in97_SendData(Yend & 0xFF);
    EPD_3in97_SendData((Yend>>8) & 0x03);
}

/******************************************************************************
function :	Set Cursor
parameter:
******************************************************************************/
static void EPD_3in97_SetCursor(UWORD Xstart, UWORD Ystart)
{
    EPD_3in97_SendCommand(0x4E); // SET_RAM_X_ADDRESS_COUNTER
    EPD_3in97_SendData(Xstart & 0xFF);
    EPD_3in97_SendData((Xstart>>8) & 0x03);

    EPD_3in97_SendCommand(0x4F); // SET_RAM_Y_ADDRESS_COUNTER
    EPD_3in97_SendData(Ystart & 0xFF);
    EPD_3in97_SendData((Ystart>>8) & 0x03);
}

/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_3in97_Init(void)
{
    EPD_3in97_Reset();
    DEV_Delay_ms(100);

    EPD_3in97_ReadBusy();
    EPD_3in97_SendCommand(0x12);  //SWRESET
    EPD_3in97_ReadBusy();

    EPD_3in97_SendCommand(0x18); // use the internal temperature sensor
    EPD_3in97_SendData(0x80);

    EPD_3in97_SendCommand(0x0C); //set soft start
    EPD_3in97_SendData(0xAE);
    EPD_3in97_SendData(0xC7);
    EPD_3in97_SendData(0xC3);
    EPD_3in97_SendData(0xC0);
    EPD_3in97_SendData(0x80);

    EPD_3in97_SendCommand(0x01);   // drive output control
    EPD_3in97_SendData((EPD_3in97_HEIGHT-1)%256);
    EPD_3in97_SendData((EPD_3in97_HEIGHT-1)/256);
    EPD_3in97_SendData(0x02);

    EPD_3in97_SendCommand(0x3C);   // border setting
    EPD_3in97_SendData(0x01);

    EPD_3in97_SendCommand(0x11);   // data entry mode: X-mode x+ y-
    EPD_3in97_SendData(0x01);

    EPD_3in97_SetWindows(0, EPD_3in97_HEIGHT-1, EPD_3in97_WIDTH-1, 0);

    EPD_3in97_SetCursor(0, 0);

    EPD_3in97_SendCommand(0x21);   // display update control: bypass RED as 0
    EPD_3in97_SendData(0x40);
    EPD_3in97_SendData(0x00);

    EPD_3in97_ReadBusy();
}

/******************************************************************************
function :	Clear screen
parameter:
******************************************************************************/
void EPD_3in97_Clear(void)
{
    UWORD i;
    UWORD height = EPD_3in97_HEIGHT;
    UWORD width = EPD_3in97_WIDTH/8;
    UBYTE image[EPD_3in97_WIDTH / 8];
    for(i=0; i<width; i++) {
        image[i] = 0xff;
    }

    EPD_3in97_SendCommand(0x24);   //write RAM for black(0)/white (1)
    for(i=0; i<height; i++)
    {
        EPD_3in97_SendData2(image, width);
    }

    EPD_3in97_SendCommand(0x26);   //write RAM for black(0)/white (1)
    for(i=0; i<height; i++)
    {
        EPD_3in97_SendData2(image, width);
    }
    EPD_3in97_TurnOnDisplay();
}

/******************************************************************************
function :	Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_3in97_Display(UBYTE *Image)
{
    UWORD i;
    UWORD height = EPD_3in97_HEIGHT;
    UWORD width = EPD_3in97_WIDTH/8;

    EPD_3in97_SendCommand(0x24);   //write RAM for black(0)/white (1)
    for(i=0; i<height; i++)
    {
        EPD_3in97_SendData2((UBYTE *)(Image+i*width), width);
    }
    EPD_3in97_TurnOnDisplay();
}

/******************************************************************************
function :	Enter sleep mode
parameter:
******************************************************************************/
void EPD_3in97_Sleep(void)
{
    EPD_3in97_SendCommand(0x10); //enter deep sleep
    EPD_3in97_SendData(0x03);
    DEV_Delay_ms(100);
}
