/*****************************************************************************
* | File      	:  	EPD_2in9_V3.c
* | Author      :   Waveshare team
* | Function    :   2.9inch e-paper V3
* | Info        :
*----------------
* |	This version:   V1.2
* | Date        :   2023-12-21
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
#include "EPD_2in9_V3.h"
#include "Debug.h"
#include <time.h> 

/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_2IN9_V3_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(2);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_2IN9_V3_SendCommand(UBYTE Reg)
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
static void EPD_2IN9_V3_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);
}

/******************************************************************************
function :	Wait until the busy_pin goes LOW
parameter:
******************************************************************************/
void EPD_2IN9_V3_ReadBusy(void)
{
    Debug("e-Paper busy\r\n");
	UDOUBLE busy_wait_ms = 0;
	while(1)
	{	 //=1 BUSY
		if(DEV_Digital_Read(EPD_BUSY_PIN)==0) 
			break;
		if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
			Debug("e-Paper busy timeout\r\n");
			break;
		}
		DEV_Delay_ms(50);
		busy_wait_ms += 50;
	}
	DEV_Delay_ms(50);
    Debug("e-Paper busy release\r\n");
}

/******************************************************************************
function :	Turn On Display
parameter:
******************************************************************************/
static void EPD_2IN9_V3_TurnOnDisplay(void)
{
	EPD_2IN9_V3_SendCommand(0x22); //Display Update Control
	EPD_2IN9_V3_SendData(0xF7);
	EPD_2IN9_V3_SendCommand(0x20); //Activate Display Update Sequence
	EPD_2IN9_V3_ReadBusy();
}

static void EPD_2IN9_V3_TurnOnDisplay_Fast(void)
{
	EPD_2IN9_V3_SendCommand(0x22); //Display Update Control
	EPD_2IN9_V3_SendData(0xD7);
	EPD_2IN9_V3_SendCommand(0x20); //Activate Display Update Sequence
	EPD_2IN9_V3_ReadBusy();
}

static void EPD_2IN9_V3_TurnOnDisplay_GRAY4(void)
{
	EPD_2IN9_V3_SendCommand(0x22); //Display Update Control
	EPD_2IN9_V3_SendData(0xD7);
	EPD_2IN9_V3_SendCommand(0x20); //Activate Display Update Sequence
	EPD_2IN9_V3_ReadBusy();
}

static void EPD_2IN9_V3_TurnOnDisplay_Partial(void)
{
	EPD_2IN9_V3_SendCommand(0x22); //Display Update Control
	EPD_2IN9_V3_SendData(0xFF);   
	EPD_2IN9_V3_SendCommand(0x20); //Activate Display Update Sequence
	EPD_2IN9_V3_ReadBusy();
}

/******************************************************************************
function :	Setting the display window
parameter:
******************************************************************************/
static void EPD_2IN9_V3_SetWindows(UWORD Xstart, UWORD Ystart, UWORD Xend, UWORD Yend)
{
    EPD_2IN9_V3_SendCommand(0x44); // SET_RAM_X_ADDRESS_START_END_POSITION
    EPD_2IN9_V3_SendData((Xstart>>3) & 0xFF);
    EPD_2IN9_V3_SendData((Xend>>3) & 0xFF);
	
    EPD_2IN9_V3_SendCommand(0x45); // SET_RAM_Y_ADDRESS_START_END_POSITION
    EPD_2IN9_V3_SendData(Ystart & 0xFF);
    EPD_2IN9_V3_SendData((Ystart >> 8) & 0xFF);
    EPD_2IN9_V3_SendData(Yend & 0xFF);
    EPD_2IN9_V3_SendData((Yend >> 8) & 0xFF);
}

/******************************************************************************
function :	Set Cursor
parameter:
******************************************************************************/
static void EPD_2IN9_V3_SetCursor(UWORD Xstart, UWORD Ystart)
{
    EPD_2IN9_V3_SendCommand(0x4E); // SET_RAM_X_ADDRESS_COUNTER
    EPD_2IN9_V3_SendData(Xstart & 0xFF);

    EPD_2IN9_V3_SendCommand(0x4F); // SET_RAM_Y_ADDRESS_COUNTER
    EPD_2IN9_V3_SendData(Ystart & 0xFF);
    EPD_2IN9_V3_SendData((Ystart >> 8) & 0xFF);
}

/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_2IN9_V3_Init(void)
{
	EPD_2IN9_V3_Reset();
	DEV_Delay_ms(100);

	EPD_2IN9_V3_ReadBusy();   
	EPD_2IN9_V3_SendCommand(0x12); // soft reset
	EPD_2IN9_V3_ReadBusy();
	
	EPD_2IN9_V3_SendCommand(0x01); //Driver output control      
	EPD_2IN9_V3_SendData(0x27);
	EPD_2IN9_V3_SendData(0x01);
	EPD_2IN9_V3_SendData(0x00);
	
	EPD_2IN9_V3_SendCommand(0x11); //data entry mode       
	EPD_2IN9_V3_SendData(0x03);
	
	EPD_2IN9_V3_SetWindows(0, 0, EPD_2IN9_V3_WIDTH-1, EPD_2IN9_V3_HEIGHT-1);
	
	EPD_2IN9_V3_SendCommand(0x21); //  Display update control
	EPD_2IN9_V3_SendData(0x00);
	EPD_2IN9_V3_SendData(0x80);	
	
	EPD_2IN9_V3_SetCursor(0, 0);
	EPD_2IN9_V3_ReadBusy();	
	
}

void EPD_2IN9_V3_Init_Fast(void)
{
	EPD_2IN9_V3_Reset();
	DEV_Delay_ms(100);

	EPD_2IN9_V3_ReadBusy();   
	EPD_2IN9_V3_SendCommand(0x12); // soft reset
	EPD_2IN9_V3_ReadBusy();

    EPD_2IN9_V3_SendCommand(0x1a);
    EPD_2IN9_V3_SendData(100);
	
	EPD_2IN9_V3_SendCommand(0x01); //Driver output control      
	EPD_2IN9_V3_SendData(0x27);
	EPD_2IN9_V3_SendData(0x01);
	EPD_2IN9_V3_SendData(0x00);
	
	EPD_2IN9_V3_SendCommand(0x11); //data entry mode       
	EPD_2IN9_V3_SendData(0x03);
	
	EPD_2IN9_V3_SetWindows(0, 0, EPD_2IN9_V3_WIDTH-1, EPD_2IN9_V3_HEIGHT-1);
	
    EPD_2IN9_V3_SendCommand(0x3C);       
	EPD_2IN9_V3_SendData(0x05);

	EPD_2IN9_V3_SendCommand(0x21); //  Display update control
	EPD_2IN9_V3_SendData(0x00);
	EPD_2IN9_V3_SendData(0x80);	
	
	EPD_2IN9_V3_SetCursor(0, 0);
	// EPD_2IN9_V3_ReadBusy();	
}

void EPD_2IN9_V3_Gray4_Init(void)
{
	EPD_2IN9_V3_Reset();
	DEV_Delay_ms(100);

	EPD_2IN9_V3_ReadBusy();   
	EPD_2IN9_V3_SendCommand(0x12); // soft reset
	EPD_2IN9_V3_ReadBusy();

    EPD_2IN9_V3_SendCommand(0x1a);
    EPD_2IN9_V3_SendData(90);

    EPD_2IN9_V3_SendCommand(0x74); //set analog block control       
	EPD_2IN9_V3_SendData(0x54);
	EPD_2IN9_V3_SendCommand(0x7E); //set digital block control          
	EPD_2IN9_V3_SendData(0x3B);
	
	EPD_2IN9_V3_SendCommand(0x01); //Driver output control      
	EPD_2IN9_V3_SendData(0x27);
	EPD_2IN9_V3_SendData(0x01);
	EPD_2IN9_V3_SendData(0x00);
	
	EPD_2IN9_V3_SendCommand(0x11); //data entry mode       
	EPD_2IN9_V3_SendData(0x03);
	
	EPD_2IN9_V3_SetWindows(0, 0, EPD_2IN9_V3_WIDTH-1, EPD_2IN9_V3_HEIGHT-1);

	EPD_2IN9_V3_SendCommand(0x3C);       
	EPD_2IN9_V3_SendData(0x00);
	
    EPD_2IN9_V3_SendCommand(0x21); //  Display update control
	EPD_2IN9_V3_SendData(0x00);
	EPD_2IN9_V3_SendData(0x80);

	EPD_2IN9_V3_SetCursor(0, 0);
	EPD_2IN9_V3_ReadBusy();	

}

/******************************************************************************
function :	Clear screen
parameter:
******************************************************************************/
void EPD_2IN9_V3_Clear(void)
{
	UWORD i;
	
	EPD_2IN9_V3_SendCommand(0x24);   //write RAM for black(0)/white (1)
	for(i=0;i<4736;i++)
	{
		EPD_2IN9_V3_SendData(0xff);
	}

	EPD_2IN9_V3_SendCommand(0x26);   //write RAM for black(0)/white (1)
	for(i=0;i<4736;i++)
	{
		EPD_2IN9_V3_SendData(0xff);
	}
	EPD_2IN9_V3_TurnOnDisplay();
}

/******************************************************************************
function :	Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_2IN9_V3_Display(UBYTE *Image)
{
	UWORD i;	
	EPD_2IN9_V3_SendCommand(0x24);   //write RAM for black(0)/white (1)
	for(i=0;i<4736;i++)
	{
		EPD_2IN9_V3_SendData(Image[i]);
	}
	EPD_2IN9_V3_TurnOnDisplay();	
}

void EPD_2IN9_V3_Display_Base(UBYTE *Image)
{
	UWORD i;   

	EPD_2IN9_V3_SendCommand(0x24);   //Write Black and White image to RAM
	for(i=0;i<4736;i++)
	{               
		EPD_2IN9_V3_SendData(Image[i]);
	}
	EPD_2IN9_V3_SendCommand(0x26);   //Write Black and White image to RAM
	for(i=0;i<4736;i++)
	{               
		EPD_2IN9_V3_SendData(Image[i]);
	}
	EPD_2IN9_V3_TurnOnDisplay();	
}

void EPD_2IN9_V3_Display_Fast(UBYTE *Image)
{
	UWORD i;	
	EPD_2IN9_V3_SendCommand(0x24);   //write RAM for black(0)/white (1)
	for(i=0;i<4736;i++)
	{
		EPD_2IN9_V3_SendData(Image[i]);
	}
    EPD_2IN9_V3_SendCommand(0x26);   //Write Black and White image to RAM
	for(i=0;i<4736;i++)
	{               
		EPD_2IN9_V3_SendData(Image[i]);
	}
	EPD_2IN9_V3_TurnOnDisplay_Fast();	
}

void EPD_2IN9_V3_4GrayDisplay(UBYTE *Image)
{
    UDOUBLE i,j,k;
    UBYTE temp1,temp2,temp3;

    // old  data
    EPD_2IN9_V3_SendCommand(0x24);
    for(i=0; i<4736; i++) { 
        temp3=0;
        for(j=0; j<2; j++) {
            temp1 = Image[i*2+j];
            for(k=0; k<2; k++) {
                temp2 = temp1&0xC0;
                if(temp2 == 0xC0)
                    temp3 |= 0x00;
                else if(temp2 == 0x00)
                    temp3 |= 0x01; 
                else if(temp2 == 0x80)
                    temp3 |= 0x01; 
                else //0x40
                    temp3 |= 0x00; 
                temp3 <<= 1;

                temp1 <<= 2;
                temp2 = temp1&0xC0 ;
                if(temp2 == 0xC0) 
                    temp3 |= 0x00;
                else if(temp2 == 0x00) 
                    temp3 |= 0x01;
                else if(temp2 == 0x80)
                    temp3 |= 0x01; 
                else    //0x40
                    temp3 |= 0x00;	
                if(j!=1 || k!=1)
                    temp3 <<= 1;

                temp1 <<= 2;
            }
        }
        EPD_2IN9_V3_SendData(temp3);
        // printf("%x ",temp3);
    }

    EPD_2IN9_V3_SendCommand(0x26);   //write RAM for black(0)/white (1)
    for(i=0; i<4736; i++) {            
        temp3=0;
        for(j=0; j<2; j++) {
            temp1 = Image[i*2+j];
            for(k=0; k<2; k++) {
                temp2 = temp1&0xC0 ;
                if(temp2 == 0xC0)
                    temp3 |= 0x00;//white
                else if(temp2 == 0x00)
                    temp3 |= 0x01;  //black
                else if(temp2 == 0x80)
                    temp3 |= 0x00;  //gray1
                else //0x40
                    temp3 |= 0x01; //gray2
                temp3 <<= 1;

                temp1 <<= 2;
                temp2 = temp1&0xC0 ;
                if(temp2 == 0xC0)  //white
                    temp3 |= 0x00;
                else if(temp2 == 0x00) //black
                    temp3 |= 0x01;
                else if(temp2 == 0x80)
                    temp3 |= 0x00; //gray1
                else    //0x40
                    temp3 |= 0x01;	//gray2
                if(j!=1 || k!=1)
                    temp3 <<= 1;

                temp1 <<= 2;
            }
        }
        EPD_2IN9_V3_SendData(temp3);
        // printf("%x ",temp3);
    }

    EPD_2IN9_V3_TurnOnDisplay_GRAY4();
}

void EPD_2IN9_V3_Display_Partial(const UBYTE *Image, UWORD Xstart, UWORD Ystart, UWORD Xend, UWORD Yend)
{
	if((Xstart % 8 + Xend % 8 == 8 && Xstart % 8 > Xend % 8) || Xstart % 8 + Xend % 8 == 0 || (Xend - Xstart)%8 == 0)
    {
        Xstart = Xstart / 8 ;
        Xend = Xend / 8;
    }
    else
    {
        Xstart = Xstart / 8 ;
        Xend = Xend % 8 == 0 ? Xend / 8 : Xend / 8 + 1;
    }
    

    UWORD i, Width;
	Width = Xend -  Xstart;
	UWORD IMAGE_COUNTER = Width * (Yend-Ystart);

	Xend -= 1;
	Yend -= 1;

    //Reset
    EPD_2IN9_V3_Reset();

    EPD_2IN9_V3_SendCommand(0x3C); //BorderWavefrom
    EPD_2IN9_V3_SendData(0x80);	
    //	
    EPD_2IN9_V3_SendCommand(0x44);       // set RAM x address start/end, in page 35
    EPD_2IN9_V3_SendData(Xstart & 0xff);    // RAM x address start at 00h;
    EPD_2IN9_V3_SendData(Xend & 0xff);    // RAM x address end at 0fh(15+1)*8->128 
    EPD_2IN9_V3_SendCommand(0x45);       // set RAM y address start/end, in page 35
    EPD_2IN9_V3_SendData(Ystart & 0xff);    // RAM y address start at 0127h;
    EPD_2IN9_V3_SendData((Ystart>>8) & 0x01);    // RAM y address start at 0127h;
    EPD_2IN9_V3_SendData(Yend & 0xff);    // RAM y address end at 00h;
    EPD_2IN9_V3_SendData((Yend>>8) & 0x01); 

    EPD_2IN9_V3_SendCommand(0x4E);   // set RAM x address count to 0;
    EPD_2IN9_V3_SendData(Xstart & 0xff); 
    EPD_2IN9_V3_SendCommand(0x4F);   // set RAM y address count to 0X127;    
    EPD_2IN9_V3_SendData(Ystart & 0xff);
    EPD_2IN9_V3_SendData((Ystart>>8) & 0x01);


    EPD_2IN9_V3_SendCommand(0x24);   //Write Black and White image to RAM
    for (i = 0; i < IMAGE_COUNTER; i++) {
	    EPD_2IN9_V3_SendData(Image[i]);
	}
	EPD_2IN9_V3_TurnOnDisplay_Partial();
}

/******************************************************************************
function :	Enter sleep mode
parameter:
******************************************************************************/
void EPD_2IN9_V3_Sleep(void)
{
	EPD_2IN9_V3_SendCommand(0x10); //enter deep sleep
	EPD_2IN9_V3_SendData(0x01); 
	DEV_Delay_ms(100);
}
