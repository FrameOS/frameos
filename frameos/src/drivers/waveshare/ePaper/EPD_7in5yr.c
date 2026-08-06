// SPDX-License-Identifier: GPL-3.0-or-later
/*****************************************************************************
* | File      	:   EPD_7in5yr.c
* | Function    :   7.5inch e-paper black/white/yellow/red — the Good Display
* |                 GDEM075F52 panel used by the TRMNL BWRY.
* | Info        :   UC81xx-class controller, 800x480, 2 bits per pixel
* |                 (00 black, 01 white, 10 yellow, 11 red), one data plane
* |                 written with command 0x10, refreshed with 0x12.
* |
* | This driver was AI-generated (Claude, Anthropic) for FrameOS. The panel
* | register init sequence is derived from the EP75YR_800x480 support in the
* | bb_epaper library, https://github.com/bitbank2/bb_epaper,
* | SPDX-FileCopyrightText: 2024 BitBank Software, Inc. / Larry Bank,
* | licensed GPL-3.0-or-later. The driver structure follows the Waveshare
* | reference drivers in this directory (EPD_7in3g.c).
*----------------
* |	This version:   V1.0
* | Date        :   2026-08-06
******************************************************************************/
#include "EPD_7in5yr.h"
#include "Debug.h"

/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_7IN5YR_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(2);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_7IN5YR_SendCommand(UBYTE Reg)
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
static void EPD_7IN5YR_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

static void EPD_7IN5YR_SendData2(UBYTE *pData, UDOUBLE len)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Write_nByte(pData, len);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :	Wait until the busy_pin goes HIGH (LOW: busy, HIGH: idle)
parameter:
******************************************************************************/
static void EPD_7IN5YR_ReadBusyH(void)
{
    Debug("e-Paper busy H\r\n");
    UDOUBLE busy_wait_ms = 0;
    while(!DEV_Digital_Read(EPD_BUSY_PIN)) {
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            break;
        }
        DEV_Delay_ms(5);
        busy_wait_ms += 5;
    }
    Debug("e-Paper busy H release\r\n");
}

/******************************************************************************
function :	Turn On Display
parameter:
******************************************************************************/
static void EPD_7IN5YR_TurnOnDisplay(void)
{
    EPD_7IN5YR_SendCommand(0x12); // DISPLAY_REFRESH
    EPD_7IN5YR_SendData(0x00);
    EPD_7IN5YR_ReadBusyH();

    EPD_7IN5YR_SendCommand(0x02); // POWER_OFF
    EPD_7IN5YR_SendData(0X00);
    EPD_7IN5YR_ReadBusyH();
}

/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_7IN5YR_Init(void)
{
    EPD_7IN5YR_Reset();
    EPD_7IN5YR_ReadBusyH();

    EPD_7IN5YR_SendCommand(0x00); // PSR
    EPD_7IN5YR_SendData(0x0F);
    EPD_7IN5YR_SendData(0x29);

    EPD_7IN5YR_SendCommand(0x06); // BTST
    EPD_7IN5YR_SendData(0x0F);
    EPD_7IN5YR_SendData(0x8B);
    EPD_7IN5YR_SendData(0x93);
    EPD_7IN5YR_SendData(0xA1);

    EPD_7IN5YR_SendCommand(0x41);
    EPD_7IN5YR_SendData(0x00);

    EPD_7IN5YR_SendCommand(0x50); // CDI
    EPD_7IN5YR_SendData(0x37);

    EPD_7IN5YR_SendCommand(0x60); // TCON
    EPD_7IN5YR_SendData(0x02);
    EPD_7IN5YR_SendData(0x02);

    EPD_7IN5YR_SendCommand(0x61); // TRES: 800x480
    EPD_7IN5YR_SendData(0x03);
    EPD_7IN5YR_SendData(0x20);
    EPD_7IN5YR_SendData(0x01);
    EPD_7IN5YR_SendData(0xE0);

    EPD_7IN5YR_SendCommand(0x62);
    EPD_7IN5YR_SendData(0x98);
    EPD_7IN5YR_SendData(0x98);
    EPD_7IN5YR_SendData(0x98);
    EPD_7IN5YR_SendData(0x75);
    EPD_7IN5YR_SendData(0xCA);
    EPD_7IN5YR_SendData(0xB2);
    EPD_7IN5YR_SendData(0x98);
    EPD_7IN5YR_SendData(0x7E);

    EPD_7IN5YR_SendCommand(0x65);
    EPD_7IN5YR_SendData(0x00);
    EPD_7IN5YR_SendData(0x00);
    EPD_7IN5YR_SendData(0x00);
    EPD_7IN5YR_SendData(0x00);

    EPD_7IN5YR_SendCommand(0xE7);
    EPD_7IN5YR_SendData(0x1C);

    EPD_7IN5YR_SendCommand(0xE3);
    EPD_7IN5YR_SendData(0x00);

    EPD_7IN5YR_SendCommand(0xE9);
    EPD_7IN5YR_SendData(0x01);

    EPD_7IN5YR_SendCommand(0x30); // PLL
    EPD_7IN5YR_SendData(0x08);

    EPD_7IN5YR_SendCommand(0x04); // POWER_ON
    EPD_7IN5YR_ReadBusyH();

    EPD_7IN5YR_SendCommand(0xE0);
    EPD_7IN5YR_SendData(0x02);

    EPD_7IN5YR_SendCommand(0xE6);
    EPD_7IN5YR_SendData(0x5A);

    EPD_7IN5YR_SendCommand(0xA5);
    EPD_7IN5YR_SendData(0x00);

    EPD_7IN5YR_ReadBusyH();
}

/******************************************************************************
function :	Clear screen
parameter:
******************************************************************************/
void EPD_7IN5YR_Clear(UBYTE color)
{
    UWORD Width, Height;
    Width = (EPD_7IN5YR_WIDTH % 4 == 0)? (EPD_7IN5YR_WIDTH / 4 ): (EPD_7IN5YR_WIDTH / 4 + 1);
    Height = EPD_7IN5YR_HEIGHT;

    EPD_7IN5YR_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_7IN5YR_SendData((color << 6) | (color << 4) | (color << 2) | color);
        }
    }
    EPD_7IN5YR_TurnOnDisplay();
}

/******************************************************************************
function :	Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_7IN5YR_Display(UBYTE *Image)
{
    UWORD Width, Height;
    Width = (EPD_7IN5YR_WIDTH % 4 == 0)? (EPD_7IN5YR_WIDTH / 4 ): (EPD_7IN5YR_WIDTH / 4 + 1);
    Height = EPD_7IN5YR_HEIGHT;

    EPD_7IN5YR_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        EPD_7IN5YR_SendData2((UBYTE *)(Image + j * Width), Width);
    }
    EPD_7IN5YR_TurnOnDisplay();
}

/******************************************************************************
function :	Enter sleep mode
parameter:
******************************************************************************/
void EPD_7IN5YR_Sleep(void)
{
    EPD_7IN5YR_SendCommand(0x02); // POWER_OFF
    EPD_7IN5YR_SendData(0X00);
    EPD_7IN5YR_SendCommand(0x07); // DEEP_SLEEP
    EPD_7IN5YR_SendData(0XA5);
}
