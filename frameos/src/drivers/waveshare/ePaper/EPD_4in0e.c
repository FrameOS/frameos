/*****************************************************************************
* | File        :   EPD_4in0e.c
* | Author      :   Waveshare team
* | Function    :   4inch e-Paper (E) Driver
* | Info        :
*----------------
* | This version:   V1.0
* | Date        :   2024-08-20
* | Info        :
* -----------------------------------------------------------------------------
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
#include "EPD_4in0e.h"
#include "Debug.h"

/******************************************************************************
function :  Software reset
parameter:
******************************************************************************/
static void EPD_4IN0E_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(2);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
}

/******************************************************************************
function :  send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_4IN0E_SendCommand(UBYTE Reg)
{
    DEV_Debug_Command(Reg);
    DEV_Digital_Write(EPD_DC_PIN, 0);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :  send data
parameter:
    Data : Write data
******************************************************************************/
static void EPD_4IN0E_SendData(UBYTE Data)
{
    DEV_Debug_Data(Data);
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :  Wait until the busy_pin goes LOW
parameter:
******************************************************************************/
static void EPD_4IN0E_ReadBusyH(const char *stage)
{
    Debug("e-Paper busy H\r\n");
    /* FrameOS divergence: bounded, narrated wait (DEV_Busy_Wait). */
    if (DEV_Busy_Wait(stage, 0, 10) < 0) {
        return;
    }
    DEV_Delay_ms(100);
    Debug("e-Paper busy H release\r\n");
}

/******************************************************************************
function :  Turn On Display
parameter:
******************************************************************************/
static void EPD_4IN0E_TurnOnDisplay(void)
{
    
    DEV_Debug_Log("turnOnDisplay:powerOn", NULL);
    EPD_4IN0E_SendCommand(0x04); // POWER_ON
    EPD_4IN0E_ReadBusyH("turnOnDisplay:powerOn");
    DEV_Delay_ms(200);

    //Second setting 
    DEV_Debug_Log("turnOnDisplay:secondSetting", NULL);
    EPD_4IN0E_SendCommand(0x06);
    EPD_4IN0E_SendData(0x6F);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x17);
    EPD_4IN0E_SendData(0x27);
    DEV_Delay_ms(200);

    DEV_Debug_Log("turnOnDisplay:refresh", NULL);
    EPD_4IN0E_SendCommand(0x12); // DISPLAY_REFRESH
    EPD_4IN0E_SendData(0x00);
    EPD_4IN0E_ReadBusyH("turnOnDisplay:refresh");

    DEV_Debug_Log("turnOnDisplay:powerOff", NULL);
    EPD_4IN0E_SendCommand(0x02); // POWER_OFF
    EPD_4IN0E_SendData(0X00);
    EPD_4IN0E_ReadBusyH("turnOnDisplay:powerOff");
    DEV_Debug_Log("turnOnDisplay:done", NULL);
}

/******************************************************************************
function :  Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_4IN0E_Init(void)
{
    DEV_Debug_Log("init:start", NULL);
    EPD_4IN0E_Reset();
    EPD_4IN0E_ReadBusyH("init:reset");
    DEV_Delay_ms(30);

    DEV_Debug_Log("init:cmdh", NULL);
    EPD_4IN0E_SendCommand(0xAA);    // CMDH
    EPD_4IN0E_SendData(0x49);
    EPD_4IN0E_SendData(0x55);
    EPD_4IN0E_SendData(0x20);
    EPD_4IN0E_SendData(0x08);
    EPD_4IN0E_SendData(0x09);
    EPD_4IN0E_SendData(0x18);

    DEV_Debug_Log("init:drvPLL", NULL);
    EPD_4IN0E_SendCommand(0x01);
    EPD_4IN0E_SendData(0x3F);

    DEV_Debug_Log("init:powerSetting", NULL);
    EPD_4IN0E_SendCommand(0x00);
    EPD_4IN0E_SendData(0x5F);
    EPD_4IN0E_SendData(0x69);

    DEV_Debug_Log("init:powerOptimisation1", NULL);
    EPD_4IN0E_SendCommand(0x05);
    EPD_4IN0E_SendData(0x40);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x2C);

    DEV_Debug_Log("init:powerOptimisation3", NULL);
    EPD_4IN0E_SendCommand(0x08);
    EPD_4IN0E_SendData(0x6F);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x22);

    DEV_Debug_Log("init:powerOptimisation2", NULL);
    EPD_4IN0E_SendCommand(0x06);
    EPD_4IN0E_SendData(0x6F);
    EPD_4IN0E_SendData(0x1F);
    EPD_4IN0E_SendData(0x17);
    EPD_4IN0E_SendData(0x17);

    DEV_Debug_Log("init:boosterSoftStart", NULL);
    EPD_4IN0E_SendCommand(0x03);
    EPD_4IN0E_SendData(0x00);
    EPD_4IN0E_SendData(0x54);
    EPD_4IN0E_SendData(0x00);
    EPD_4IN0E_SendData(0x44); 

    DEV_Debug_Log("init:resolution", NULL);
    EPD_4IN0E_SendCommand(0x60);
    EPD_4IN0E_SendData(0x02);
    EPD_4IN0E_SendData(0x00);

    DEV_Debug_Log("init:powerOptimisation4", NULL);
    EPD_4IN0E_SendCommand(0x30);
    EPD_4IN0E_SendData(0x08);

    DEV_Debug_Log("init:vcomAndDataInterval", NULL);
    EPD_4IN0E_SendCommand(0x50);
    EPD_4IN0E_SendData(0x3F);

    DEV_Debug_Log("init:resolutionSetting", NULL);
    EPD_4IN0E_SendCommand(0x61);
    EPD_4IN0E_SendData(0x01);
    EPD_4IN0E_SendData(0x90);
    EPD_4IN0E_SendData(0x02); 
    EPD_4IN0E_SendData(0x58);

    DEV_Debug_Log("init:pllControl", NULL);
    EPD_4IN0E_SendCommand(0xE3);
    EPD_4IN0E_SendData(0x2F);

    DEV_Debug_Log("init:vdcsSetting", NULL);
    EPD_4IN0E_SendCommand(0x84);
    EPD_4IN0E_SendData(0x01);
    EPD_4IN0E_ReadBusyH("init:done");
    DEV_Debug_Log("init:done", NULL);
}

/******************************************************************************
function :  Clear screen
parameter:
******************************************************************************/
void EPD_4IN0E_Clear(UBYTE color)
{
    UWORD Width, Height;
    Width = (EPD_4IN0E_WIDTH % 2 == 0)? (EPD_4IN0E_WIDTH / 2 ): (EPD_4IN0E_WIDTH / 2 + 1);
    Height = EPD_4IN0E_HEIGHT;

    DEV_Debug_Log("clear:start", NULL);
    EPD_4IN0E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN0E_SendData((color<<4)|color);
        }
    }

    DEV_Debug_Log("clear:dataWritten", NULL);
    EPD_4IN0E_TurnOnDisplay();
}

/******************************************************************************
function :  show 7 kind of color block
parameter:
******************************************************************************/
void EPD_4IN0E_Show7Block(void)
{
    unsigned long j, k;
    unsigned char const Color_seven[6] = 
    {EPD_4IN0E_BLACK, EPD_4IN0E_YELLOW, EPD_4IN0E_RED, EPD_4IN0E_BLUE, EPD_4IN0E_GREEN, EPD_4IN0E_WHITE};

    DEV_Debug_Log("show7Block:start", NULL);
    EPD_4IN0E_SendCommand(0x10);
    for(k = 0 ; k < 6; k ++) {
        for(j = 0 ; j < 20000; j ++) {
            EPD_4IN0E_SendData((Color_seven[k]<<4) |Color_seven[k]);
        }
    }
    DEV_Debug_Log("show7Block:dataWritten", NULL);
    EPD_4IN0E_TurnOnDisplay();
}

void EPD_4IN0E_Show(void)
{
    unsigned long k,o;
    unsigned char const Color_seven[6] = 
    {EPD_4IN0E_BLACK, EPD_4IN0E_YELLOW, EPD_4IN0E_RED, EPD_4IN0E_BLUE, EPD_4IN0E_GREEN, EPD_4IN0E_WHITE};

    UWORD Width, Height;
    Width = (EPD_4IN0E_WIDTH % 2 == 0)? (EPD_4IN0E_WIDTH / 2 ): (EPD_4IN0E_WIDTH / 2 + 1);
    Height = EPD_4IN0E_HEIGHT;
    k = 0;
    o = 0;

    DEV_Debug_Log("show:start", NULL);
    EPD_4IN0E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        if((j > 10) && (j<50))
        for (UWORD i = 0; i < Width; i++) {
                EPD_4IN0E_SendData((Color_seven[0]<<4) |Color_seven[0]);
            }
        else if(o < Height/2)
        for (UWORD i = 0; i < Width; i++) {
                EPD_4IN0E_SendData((Color_seven[0]<<4) |Color_seven[0]);
            }
        
        else
        {
            for (UWORD i = 0; i < Width; i++) {
                EPD_4IN0E_SendData((Color_seven[k]<<4) |Color_seven[k]);
                
            }
            k++ ;
            if(k >= 6)
                k = 0;
        }
            
        o++ ;
        if(o >= Height)
            o = 0;
    }
    DEV_Debug_Log("show:dataWritten", NULL);
    EPD_4IN0E_TurnOnDisplay();
}

/******************************************************************************
function :  Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_4IN0E_Display(UBYTE *Image)
{
    UWORD Width, Height;
    Width = (EPD_4IN0E_WIDTH % 2 == 0)? (EPD_4IN0E_WIDTH / 2 ): (EPD_4IN0E_WIDTH / 2 + 1);
    Height = EPD_4IN0E_HEIGHT;

    DEV_Debug_Log("display:start", NULL);
    DEV_Debug_Preview(Image, (unsigned long)Width * Height);
    EPD_4IN0E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN0E_SendData(Image[i + j * Width]);
        }
    }
    DEV_Debug_Log("display:dataWritten", NULL);
    EPD_4IN0E_TurnOnDisplay();
}

/******************************************************************************
function :  Enter sleep mode
parameter:
******************************************************************************/
void EPD_4IN0E_Sleep(void)
{
    DEV_Debug_Log("sleep", NULL);
    EPD_4IN0E_SendCommand(0x07); // DEEP_SLEEP
    EPD_4IN0E_SendData(0XA5);
    // EPD_4IN0E_ReadBusyH();
}

