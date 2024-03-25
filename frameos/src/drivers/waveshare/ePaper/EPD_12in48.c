/*****************************************************************************
* | File        :   EPD_12in48.c
* | Author      :   Waveshare team
* | Function    :   Electronic paper driver
* | Info     :
*----------------
* | This version:   V1.0
* | Date     :   2018-11-29
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
#include "EPD_12in48.h"
#include "Debug.h"

static void EPD_Reset(void);
static void EPD_M1_SendCommand(UBYTE Reg);
static void EPD_M1_SendData(UBYTE Data);
static void EPD_S1_SendCommand(UBYTE Reg);
static void EPD_S1_SendData(UBYTE Data);
static void EPD_M2_SendCommand(UBYTE Reg);
static void EPD_M2_SendData(UBYTE Data);
static void EPD_S2_SendCommand(UBYTE Reg);
static void EPD_S2_SendData(UBYTE Data);
static void EPD_M1M2_SendCommand(UBYTE Reg);
// static void EPD_M1M2_SendData(UBYTE Data);
static void EPD_M1S1M2S2_SendCommand(UBYTE Reg);
static void EPD_M1S1M2S2_SendData(UBYTE Data);
static void EPD_M1_ReadBusy(void);
static void EPD_M2_ReadBusy(void);
static void EPD_S1_ReadBusy(void);
static void EPD_S2_ReadBusy(void);
static void EPD_M1_ReadTemperature(void);

/******************************************************************************
function :  Initialize the e-Paper register
parameter:
******************************************************************************/
UBYTE EPD_12in48_Init(void)
{
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);

    EPD_Reset();

    //panel setting
    EPD_M1_SendCommand(0x00);
    EPD_M1_SendCommand(0x00);
    EPD_M1_SendData(0x1f);  //KW-3f   KWR-2F    BWROTP 0f   BWOTP 1f
    EPD_S1_SendCommand(0x00);
    EPD_S1_SendData(0x1f);
    EPD_M2_SendCommand(0x00);
    EPD_M2_SendData(0x13);
    EPD_S2_SendCommand(0x00);
    EPD_S2_SendData(0x13);

    // booster soft start
    EPD_M1_SendCommand(0x06);
    EPD_M1_SendData(0x17);  //A
    EPD_M1_SendData(0x17);  //B
    EPD_M1_SendData(0x39);  //C
    EPD_M1_SendData(0x17);
    EPD_M2_SendCommand(0x06);
    EPD_M2_SendData(0x17);
    EPD_M2_SendData(0x17);
    EPD_M2_SendData(0x39);
    EPD_M2_SendData(0x17);

    //resolution setting
    EPD_M1_SendCommand(0x61);
    EPD_M1_SendData(0x02);
    EPD_M1_SendData(0x88);  //source 648
    EPD_M1_SendData(0x01);  //gate 492
    EPD_M1_SendData(0xEC);
    EPD_S1_SendCommand(0x61);
    EPD_S1_SendData(0x02);
    EPD_S1_SendData(0x90);  //source 656
    EPD_S1_SendData(0x01);  //gate 492
    EPD_S1_SendData(0xEC);
    EPD_M2_SendCommand(0x61);
    EPD_M2_SendData(0x02);
    EPD_M2_SendData(0x90);  //source 656
    EPD_M2_SendData(0x01);  //gate 492
    EPD_M2_SendData(0xEC);
    EPD_S2_SendCommand(0x61);
    EPD_S2_SendData(0x02);
    EPD_S2_SendData(0x88);  //source 648
    EPD_S2_SendData(0x01);  //gate 492
    EPD_S2_SendData(0xEC);

    EPD_M1S1M2S2_SendCommand(0x15); //DUSPI
    EPD_M1S1M2S2_SendData(0x20);

    EPD_M1S1M2S2_SendCommand(0x50); //Vcom and data interval setting
    EPD_M1S1M2S2_SendData(0x21); //Border KW
    EPD_M1S1M2S2_SendData(0x07);

    EPD_M1S1M2S2_SendCommand(0x60);//TCON
    EPD_M1S1M2S2_SendData(0x22);

    EPD_M1S1M2S2_SendCommand(0xE3);
    EPD_M1S1M2S2_SendData(0x00);
    
    EPD_M1_ReadTemperature();
    return 0;
}

/******************************************************************************
function :  Clear screen
parameter:
******************************************************************************/
void EPD_12in48_Clear(void)
{
    UWORD y, x;
    // M1 part 648*492
    EPD_M1_SendCommand(0x10);
    for(y =  492; y < 984; y++){
        for(x = 0; x < 81; x++) {
            EPD_M1_SendData(0xff);
        }
    }        
    EPD_M1_SendCommand(0x13);
    for(y = 492; y < 984; y++){
        for(x = 0; x < 81; x++) {
            EPD_M1_SendData(0xff);
        }
    }
    // S1 part 656*492
    EPD_S1_SendCommand(0x10);
    for(y = 492; y < 984; y++){
        for(x = 81; x < 163; x++) {
            EPD_S1_SendData(0xff);
        }
    }
    EPD_S1_SendCommand(0x13);
    for(y = 492; y < 984; y++){
        for(x = 81; x < 163; x++) {
            EPD_S1_SendData(0xff);
        }
    }
    // M2 part 656*492
    EPD_M2_SendCommand(0x10);
    for(y = 0; y < 492; y++){
        for(x = 81; x < 163; x++) {
            EPD_M2_SendData(0xff);
        }
    }        
    EPD_M2_SendCommand(0x13);
    for(y = 0; y < 492; y++){
        for(x = 81; x < 163; x++) {
            EPD_M2_SendData(0xff);
        }
    }
    // S2 part 648*492
    EPD_S2_SendCommand(0x10);
    for(y = 0; y < 492; y++){
        for(x = 0; x < 81; x++) {
            EPD_S2_SendData(0xff);
        }
    }
    EPD_S2_SendCommand(0x13);
    for(y = 0; y < 492; y++){
        for(x = 0; x < 81; x++) {
            EPD_S2_SendData(0xff);
        }
    }
    
    // Turn On Display
    EPD_12in48_TurnOnDisplay();
}

/******************************************************************************
function :  Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_12in48_Display(const UBYTE *Image)
{
    int x,y;
    //S1 part 648*492
    EPD_S2_SendCommand(0x13);
    for(y = 0; y < 492; y++)
        for(x = 0; x < 81; x++) {
            EPD_S2_SendData(*(Image + (y*163 + x)));
        }

    //M2 part 656*492
    EPD_M2_SendCommand(0x13);
    for(y = 0; y < 492; y++)
        for(x = 81; x < 163; x++) {
            EPD_M2_SendData(*(Image+ (y*163) +x));
        }

    //S1 part 656*492
    EPD_S1_SendCommand(0x13);
    for(y = 492; y < 984; y++)
        for(x = 81; x < 163; x++) {
            EPD_S1_SendData(*(Image+ (y*163) +x));
        }

    //M1 part 648*492
    EPD_M1_SendCommand(0x13);
    for(y = 492; y < 984; y++)
        for(x = 0; x < 81; x++) {
            EPD_M1_SendData(*(Image+ (y*163) +x));
        }
        
    EPD_12in48_TurnOnDisplay();
}

/******************************************************************************
function :  Turn On Display
parameter:
******************************************************************************/
void EPD_12in48_TurnOnDisplay(void)
{
    EPD_M1M2_SendCommand(0x04); //power on
    DEV_Delay_ms(300);
    EPD_M1S1M2S2_SendCommand(0x12); //Display Refresh
    
    EPD_M1_ReadBusy();    
    EPD_S1_ReadBusy();    
    EPD_M2_ReadBusy();
    EPD_S2_ReadBusy();
}

/******************************************************************************
function :  Enter sleep mode
parameter:
******************************************************************************/
void EPD_12in48_Sleep(void)
{
    EPD_M1S1M2S2_SendCommand(0X02);     //power off
    DEV_Delay_ms(300);

    EPD_M1S1M2S2_SendCommand(0X07);     //deep sleep
    EPD_M1S1M2S2_SendData(0xA5);
    DEV_Delay_ms(1000);
}

/******************************************************************************
function :  Software reset
parameter:
******************************************************************************/
static void EPD_Reset(void)
{
    DEV_Digital_Write(EPD_M1S1_RST_PIN, 1);
    DEV_Digital_Write(EPD_M2S2_RST_PIN, 1);
    DEV_Delay_ms(200);
    DEV_Digital_Write(EPD_M1S1_RST_PIN, 0);
    DEV_Digital_Write(EPD_M2S2_RST_PIN, 0);
    DEV_Delay_ms(1);
    DEV_Digital_Write(EPD_M1S1_RST_PIN, 1);
    DEV_Digital_Write(EPD_M2S2_RST_PIN, 1);
    DEV_Delay_ms(200);
}

/******************************************************************************
function :  send command and data(M1\M2\S1\S2\M1S1\M1S1M2S2)
parameter:
    Reg : Command register
or:
    Data : Write data
******************************************************************************/
static void EPD_M1_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 0);
    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
}
static void EPD_M1_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);
    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
}

static void EPD_S1_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 0);
    DEV_Digital_Write(EPD_S1_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
}
static void EPD_S1_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);
    DEV_Digital_Write(EPD_S1_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
}

static void EPD_M2_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 0);
    DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
}
static void EPD_M2_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
}

static void EPD_S2_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 0);
    DEV_Digital_Write(EPD_S2_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
}
static void EPD_S2_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
}

static void EPD_M1M2_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 0);
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 0);
    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
}
// static void EPD_M1M2_SendData(UBYTE Data)
// {
    // DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);
    // DEV_Digital_Write(EPD_M2S2_DC_PIN, 1);
    // DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    // DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    // DEV_SPI_WriteByte(Data);
    // DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    // DEV_Digital_Write(EPD_M2_CS_PIN, 1);
// }

static void EPD_M1S1M2S2_SendCommand(UBYTE Reg)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 0);  // command write
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 0);  // command write

    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_Digital_Write(EPD_S1_CS_PIN, 0);
    DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    DEV_Digital_Write(EPD_S2_CS_PIN, 0);
    DEV_SPI_WriteByte(Reg);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
}
static void EPD_M1S1M2S2_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);  // command write
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 1);  // command write

    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_Digital_Write(EPD_S1_CS_PIN, 0);
    DEV_Digital_Write(EPD_M2_CS_PIN, 0);
    DEV_Digital_Write(EPD_S2_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
}

/******************************************************************************
function :  Wait until the busy_pin goes LOW(M1\M2\S1\S2)
parameter:
******************************************************************************/
static void EPD_M1_ReadBusy(void)
{
    UBYTE busy;
    do {
        EPD_M1_SendCommand(0x71);
        busy = DEV_Digital_Read(EPD_M1_BUSY_PIN);
        busy =!(busy & 0x01);
    } while(busy);
    Debug("M1 Busy free\r\n");
    DEV_Delay_ms(200);
}
static void EPD_M2_ReadBusy(void)
{
    UBYTE busy;
    do {
        EPD_M2_SendCommand(0x71);
        busy = DEV_Digital_Read(EPD_M2_BUSY_PIN);
        busy =!(busy & 0x01);
    } while(busy);
    Debug("M2 Busy free\r\n");
    DEV_Delay_ms(200);
}
static void EPD_S1_ReadBusy(void)
{
    UBYTE busy;
    do {
        EPD_S1_SendCommand(0x71);
        busy = DEV_Digital_Read(EPD_S1_BUSY_PIN);
        busy =!(busy & 0x01);
    } while(busy);
    Debug("S1 Busy free\r\n");
    DEV_Delay_ms(200);
}
static void EPD_S2_ReadBusy(void)
{
    UBYTE busy;
    do {
        EPD_S2_SendCommand(0x71);
        busy = DEV_Digital_Read(EPD_S2_BUSY_PIN);
        busy =!(busy & 0x01);
    } while(busy);
    Debug("S2 Busy free\r\n");
    DEV_Delay_ms(200);
}

/******************************************************************************
function :  ReadTemperature
parameter:
******************************************************************************/
static void EPD_M1_ReadTemperature(void)
{
    EPD_M1_SendCommand(0x40);
    EPD_M1_ReadBusy();
    DEV_Delay_ms(300);

    DEV_Digital_Write(EPD_M1_CS_PIN, 0);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
    
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);
    DEV_Delay_us(5);
    
    UBYTE temp;
    temp = DEV_SPI_ReadByte(0x00);    
    DEV_Digital_Write(EPD_M1_CS_PIN, 1); 
    printf("Read Temperature Reg:%d\r\n", temp);
    
    EPD_M1S1M2S2_SendCommand(0xe0);//Cascade setting
    EPD_M1S1M2S2_SendData(0x03);
    EPD_M1S1M2S2_SendCommand(0xe5);//Force temperature
    EPD_M1S1M2S2_SendData(temp);
    
}
