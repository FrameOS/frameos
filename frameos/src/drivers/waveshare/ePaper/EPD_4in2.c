/*****************************************************************************
* | File      	:   EPD_4in2.c
* | Author      :   Waveshare team
* | Function    :   4.2inch e-paper
* | Info        :
*----------------
* |	This version:   V3.1
* | Date        :   2019-11-14
* | Info        :
* -----------------------------------------------------------------------------
* V3.1(2019-11-14):
* 1.Add 4 grayscale drive and display program
*	 Add EPD_4IN2_4Gray_lut_vcom[]
*	 Add EPD_4IN2_4Gray_lut_ww[]
*	 Add EPD_4IN2_4Gray_lut_bw[]
*	 Add EPD_4IN2_4Gray_lut_wb
*	 Add EPD_4IN2_4Gray_lut_bb
*	 Add EPD_4IN2_Partial_SetLut()
*	 Add EPD_4IN2_4Gray_lut()
*	 Add EPD_4IN2_Init_4Gray()
*	 Add EPD_4IN2_4GrayDisplay(....)
* 2.Add partial refresh display
* 	 Add EPD_4IN2_Partial_lut_vcom1[]
* 	 Add EPD_4IN2_Partial_lut_ww1[]
* 	 Add EPD_4IN2_Partial_lut_bw1[]
* 	 Add EPD_4IN2_Partial_lut_wb1[]
* 	 Add EPD_4IN2_Partial_lut_bb1[]
* 	 Add EPD_4IN2_Partial_SetLut()
* 	 Add EPD_4IN2_PartialDisplay(...)
* 	 Poor display, no display function by default
*
* V3.0(2019-06-13):
* 1.Change:
*    lut_vcomDC[]  => EPD_4IN2_lut_vcomDC[]
*    lut_ww[] => EPD_4IN2_lut_ww[]
*    lut_bw[] => EPD_4IN2_lut_bw[]
*    lut_wb[] => EPD_4IN2_lut_wb[]
*    lut_bb[] => EPD_4IN2_lut_bb[]
*    EPD_Reset() => EPD_4IN2_Reset()
*    EPD_SendCommand() => EPD_4IN2_SendCommand()
*    EPD_SendData() => EPD_4IN2_SendData()
*    EPD_WaitUntilIdle() => EPD_4IN2_ReadBusy()
*    EPD_SetFullReg() => EPD_4IN2_SetFullReg()
*    EPD_SetPartReg() => EPD_4IN2_SetPartReg()
*    EPD_TurnOnDisplay() => EPD_4IN2_TurnOnDisplay()
*    EPD_Init() => EPD_4IN2_Init()
*    EPD_Clear() => EPD_4IN2_Clear()
*    EPD_Display() => EPD_4IN2_Display()
*    EPD_Sleep() => EPD_4IN2_Sleep()
* 2.remove commands define:
*    #define PANEL_SETTING                               0x00
*    #define POWER_SETTING                               0x01
*    #define POWER_OFF                                   0x02
*    #define POWER_OFF_SEQUENCE_SETTING                  0x03
*    #define POWER_ON                                    0x04
*    #define POWER_ON_MEASURE                            0x05
*    #define BOOSTER_SOFT_START                          0x06
*    #define DEEP_SLEEP                                  0x07
*    #define DATA_START_TRANSMISSION_1                   0x10
*    #define DATA_STOP                                   0x11
*    #define DISPLAY_REFRESH                             0x12
*    #define DATA_START_TRANSMISSION_2                   0x13
*    #define VCOM_LUT                                    0x20
*    #define W2W_LUT                                     0x21
*    #define B2W_LUT                                     0x22
*    #define W2B_LUT                                     0x23
*    #define B2B_LUT                                     0x24
*    #define PLL_CONTROL                                 0x30
*    #define TEMPERATURE_SENSOR_CALIBRATION              0x40
*    #define TEMPERATURE_SENSOR_SELECTION                0x41
*    #define TEMPERATURE_SENSOR_WRITE                    0x42
*    #define TEMPERATURE_SENSOR_READ                     0x43
*    #define VCOM_AND_DATA_INTERVAL_SETTING              0x50
*    #define LOW_POWER_DETECTION                         0x51
*    #define TCON_SETTING                                0x60
*    #define RESOLUTION_SETTING                          0x61
*    #define GET_STATUS                                  0x71
*    #define AUTO_MEASURE_VCOM                           0x80
*    #define READ_VCOM_VALUE                             0x81
*    #define VCM_DC_SETTING                              0x82
*    #define PARTIAL_WINDOW                              0x90
*    #define PARTIAL_IN                                  0x91
*    #define PARTIAL_OUT                                 0x92
*    #define PROGRAM_MODE                                0xA0
*    #define ACTIVE_PROGRAM                              0xA1
*    #define READ_OTP_DATA                               0xA2
*    #define POWER_SAVING                                0xE3
* V2.0(2018-10-30):
* 1.Remove:ImageBuff[EPD_HEIGHT * EPD_WIDTH / 8]
* 2.Change:EPD_Display(UBYTE *Image)
*   Need to pass parameters: pointer to cached data
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
#include "EPD_4in2.h"
#include "Debug.h"
#include <string.h>

static const unsigned char EPD_4IN2_lut_vcom0[] = {
    0x00, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x0F, 0x0F, 0x00, 0x00, 0x01,	
	0x00, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 					
	};
static const unsigned char EPD_4IN2_lut_ww[] = {
	0x50, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x90, 0x0F, 0x0F, 0x00, 0x00, 0x01,	
	0xA0, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	};
static const unsigned char EPD_4IN2_lut_bw[] = {
	0x50, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x90, 0x0F, 0x0F, 0x00, 0x00, 0x01,	
	0xA0, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	};
static const unsigned char EPD_4IN2_lut_wb[] = {
	0xA0, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x90, 0x0F, 0x0F, 0x00, 0x00, 0x01,	
	0x50, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	};
static const unsigned char EPD_4IN2_lut_bb[] = {
	0x20, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x90, 0x0F, 0x0F, 0x00, 0x00, 0x01,	
	0x10, 0x08, 0x08, 0x00, 0x00, 0x02,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,	
	};

/******************************partial screen update LUT*********************************/
const unsigned char EPD_4IN2_Partial_lut_vcom1[] ={
    0x00, 0x01, 0x20, 0x01, 0x00, 0x01, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

const unsigned char EPD_4IN2_Partial_lut_ww1[] ={
    0x00, 0x01, 0x20, 0x01, 0x00, 0x01, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

const unsigned char EPD_4IN2_Partial_lut_bw1[] ={
    0x20, 0x01, 0x20, 0x01, 0x00, 0x01, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
};

const unsigned char EPD_4IN2_Partial_lut_wb1[] ={
    0x10, 0x01, 0x20, 0x01, 0x00, 0x01, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
};

const unsigned char EPD_4IN2_Partial_lut_bb1[] ={
    0x00, 0x01,0x20, 0x01, 0x00, 0x01, 
    0x00, 0x00,0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00,0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00,0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00,0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00,0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,0x00, 0x00, 0x00, 0x00, 
};


/******************************gray*********************************/
//0~3 gray
const unsigned char EPD_4IN2_4Gray_lut_vcom[] =
{
    0x00 ,0x0A ,0x00 ,0x00 ,0x00 ,0x01,
    0x60 ,0x14 ,0x14 ,0x00 ,0x00 ,0x01,
    0x00 ,0x14 ,0x00 ,0x00 ,0x00 ,0x01,
    0x00 ,0x13 ,0x0A ,0x01 ,0x00 ,0x01,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00
				
};
//R21
const unsigned char EPD_4IN2_4Gray_lut_ww[] ={
    0x40 ,0x0A ,0x00 ,0x00 ,0x00 ,0x01,
    0x90 ,0x14 ,0x14 ,0x00 ,0x00 ,0x01,
    0x10 ,0x14 ,0x0A ,0x00 ,0x00 ,0x01,
    0xA0 ,0x13 ,0x01 ,0x00 ,0x00 ,0x01,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
};
//R22H	r
const unsigned char EPD_4IN2_4Gray_lut_bw[] ={
    0x40 ,0x0A ,0x00 ,0x00 ,0x00 ,0x01,
    0x90 ,0x14 ,0x14 ,0x00 ,0x00 ,0x01,
    0x00 ,0x14 ,0x0A ,0x00 ,0x00 ,0x01,
    0x99 ,0x0C ,0x01 ,0x03 ,0x04 ,0x01,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
};
//R23H	w
const unsigned char EPD_4IN2_4Gray_lut_wb[] ={
    0x40 ,0x0A ,0x00 ,0x00 ,0x00 ,0x01,
    0x90 ,0x14 ,0x14 ,0x00 ,0x00 ,0x01,
    0x00 ,0x14 ,0x0A ,0x00 ,0x00 ,0x01,
    0x99 ,0x0B ,0x04 ,0x04 ,0x01 ,0x01,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
};
//R24H	b
const unsigned char EPD_4IN2_4Gray_lut_bb[] ={
    0x80 ,0x0A ,0x00 ,0x00 ,0x00 ,0x01,
    0x90 ,0x14 ,0x14 ,0x00 ,0x00 ,0x01,
    0x20 ,0x14 ,0x0A ,0x00 ,0x00 ,0x01,
    0x50 ,0x13 ,0x01 ,0x00 ,0x00 ,0x01,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
    0x00 ,0x00 ,0x00 ,0x00 ,0x00 ,0x00,
};

/******************************************************************************
function :	Software reset
parameter:
******************************************************************************/
static void EPD_4IN2_Reset(void)
{
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);

    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
	
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(10);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(10);
}

/******************************************************************************
function :	send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_4IN2_SendCommand(UBYTE Reg)
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
static void EPD_4IN2_SendData(UBYTE Data)
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
void EPD_4IN2_ReadBusy(void)
{
    Debug("e-Paper busy\r\n");
	EPD_4IN2_SendCommand(0x71);
    UDOUBLE busy_wait_ms = 0;
    while(DEV_Digital_Read(EPD_BUSY_PIN) == 0) {      //LOW: idle, HIGH: busy
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            break;
        }
		EPD_4IN2_SendCommand(0x71);
        DEV_Delay_ms(100);
        busy_wait_ms += 100;
    }
    Debug("e-Paper busy release\r\n");
}

/******************************************************************************
function :	Turn On Display
parameter:
******************************************************************************/
static void EPD_4IN2_TurnOnDisplay(void)
{
    EPD_4IN2_SendCommand(0x12);
    DEV_Delay_ms(100);
    EPD_4IN2_ReadBusy();
}

/******************************************************************************
function :	set the look-up tables
parameter:
******************************************************************************/
static void EPD_4IN2_Partial_SetLut(void)
{
	unsigned int count;
	EPD_4IN2_SendCommand(0x20);
	for(count=0;count<44;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_Partial_lut_vcom1[count]);}

	EPD_4IN2_SendCommand(0x21);
	for(count=0;count<42;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_Partial_lut_ww1[count]);}   
	
	EPD_4IN2_SendCommand(0x22);
	for(count=0;count<42;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_Partial_lut_bw1[count]);} 

	EPD_4IN2_SendCommand(0x23);
	for(count=0;count<42;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_Partial_lut_wb1[count]);} 

	EPD_4IN2_SendCommand(0x24);
	for(count=0;count<42;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_Partial_lut_bb1[count]);} 
}

static void EPD_4IN2_SetLut(void)
{
	unsigned int count;
	EPD_4IN2_SendCommand(0x20);
	for(count=0;count<36;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_lut_vcom0[count]);}

	EPD_4IN2_SendCommand(0x21);
	for(count=0;count<36;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_lut_ww[count]);}   
	
	EPD_4IN2_SendCommand(0x22);
	for(count=0;count<36;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_lut_bw[count]);} 

	EPD_4IN2_SendCommand(0x23);
	for(count=0;count<36;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_lut_wb[count]);} 

	EPD_4IN2_SendCommand(0x24);
	for(count=0;count<36;count++)	     
		{EPD_4IN2_SendData(EPD_4IN2_lut_bb[count]);}   
}

//LUT download
static void EPD_4IN2_4Gray_lut(void)
{
	unsigned int count;	 
	{
		EPD_4IN2_SendCommand(0x20);							//vcom
		for(count=0;count<42;count++)
			{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_vcom[count]);}
		
	EPD_4IN2_SendCommand(0x21);							//red not use
	for(count=0;count<42;count++)
		{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_ww[count]);}

		EPD_4IN2_SendCommand(0x22);							//bw r
		for(count=0;count<42;count++)
			{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_bw[count]);}

		EPD_4IN2_SendCommand(0x23);							//wb w
		for(count=0;count<42;count++)
			{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_wb[count]);}

		EPD_4IN2_SendCommand(0x24);							//bb b
		for(count=0;count<42;count++)
			{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_bb[count]);}

		EPD_4IN2_SendCommand(0x25);							//vcom
		for(count=0;count<42;count++)
			{EPD_4IN2_SendData(EPD_4IN2_4Gray_lut_ww[count]);}
	}	         
}
/******************************************************************************
function :	Initialize the e-Paper register
parameter:
******************************************************************************/

void EPD_4IN2_Init_Partial(void)
{
    EPD_4IN2_Reset();

    EPD_4IN2_SendCommand(0x01); // POWER SETTING
    EPD_4IN2_SendData(0x03);
    EPD_4IN2_SendData(0x00);
    EPD_4IN2_SendData(0x2b);
    EPD_4IN2_SendData(0x2b);

    EPD_4IN2_SendCommand(0x06); // boost soft start
    EPD_4IN2_SendData(0x17);		//A
    EPD_4IN2_SendData(0x17);		//B
    EPD_4IN2_SendData(0x17);		//C

    EPD_4IN2_SendCommand(0x04); // POWER_ON
    EPD_4IN2_ReadBusy();

    EPD_4IN2_SendCommand(0x00); // panel setting
    EPD_4IN2_SendData(0xbf); // KW-BF   KWR-AF	BWROTP 0f	BWOTP 1f

    EPD_4IN2_SendCommand(0x30); // PLL setting
    EPD_4IN2_SendData(0x3C); // 3A 100HZ   29 150Hz 39 200HZ	31 171HZ

    EPD_4IN2_SendCommand(0x61); // resolution setting
    EPD_4IN2_SendData(0x01);
    EPD_4IN2_SendData(0x90); //128
    EPD_4IN2_SendData(0x01); //
    EPD_4IN2_SendData(0x2c);

    EPD_4IN2_SendCommand(0x82); // vcom_DC setting
    EPD_4IN2_SendData(0x12);

    EPD_4IN2_SendCommand(0X50); // VCOM AND DATA INTERVAL SETTING
    EPD_4IN2_SendData(0x07); // 97white border 77black border		VBDF 17|D7 VBDW 97 VBDB 57		VBDF F7 VBDW 77 VBDB 37  VBDR B7

    EPD_4IN2_Partial_SetLut();
}

//UC8176C
void EPD_4IN2_Init_Fast(void)
{
	EPD_4IN2_Reset();
	EPD_4IN2_SendCommand(0x01);			//POWER SETTING 
	EPD_4IN2_SendData (0x03);	          
	EPD_4IN2_SendData (0x00);
	EPD_4IN2_SendData (0x2b);  
	EPD_4IN2_SendData (0x2b);

	EPD_4IN2_SendCommand(0x06);         //boost soft start
	EPD_4IN2_SendData (0x17);		//A
	EPD_4IN2_SendData (0x17);		//B
	EPD_4IN2_SendData (0x17);		//C       

	EPD_4IN2_SendCommand(0x04);  
	EPD_4IN2_ReadBusy();

	EPD_4IN2_SendCommand(0x00);			//panel setting
	EPD_4IN2_SendData(0xbf);		//KW-bf   KWR-2F	BWROTP 0f	BWOTP 1f


	EPD_4IN2_SendCommand(0x30);			
	EPD_4IN2_SendData (0x3c);      	// 3A 100HZ   29 150Hz 39 200HZ	31 171HZ

	EPD_4IN2_SendCommand(0x61);			//resolution setting
	EPD_4IN2_SendData (0x01);        	 
	EPD_4IN2_SendData (0x90);	 //400	
	EPD_4IN2_SendData (0x01);	 //300
	EPD_4IN2_SendData (0x2c);	   


	EPD_4IN2_SendCommand(0x82);			//vcom_DC setting  	
	EPD_4IN2_SendData (0x12);	

	EPD_4IN2_SendCommand(0X50);
	EPD_4IN2_SendData(0x97);

	EPD_4IN2_SetLut();		
		
}	

void EPD_4IN2_Init_4Gray(void)
{
	EPD_4IN2_Reset();
	EPD_4IN2_SendCommand(0x01);			//POWER SETTING
	EPD_4IN2_SendData (0x03);
	EPD_4IN2_SendData (0x00);       //VGH=20V,VGL=-20V
	EPD_4IN2_SendData (0x2b);		//VDH=15V															 
	EPD_4IN2_SendData (0x2b);		//VDL=-15V
	EPD_4IN2_SendData (0x13);

	EPD_4IN2_SendCommand(0x06);         //booster soft start
	EPD_4IN2_SendData (0x17);		//A
	EPD_4IN2_SendData (0x17);		//B
	EPD_4IN2_SendData (0x17);		//C 

	EPD_4IN2_SendCommand(0x04);
	EPD_4IN2_ReadBusy();

	EPD_4IN2_SendCommand(0x00);			//panel setting
	EPD_4IN2_SendData(0x3f);		//KW-3f   KWR-2F	BWROTP 0f	BWOTP 1f

	EPD_4IN2_SendCommand(0x30);			//PLL setting
	EPD_4IN2_SendData (0x3c);      	//100hz 

	EPD_4IN2_SendCommand(0x61);			//resolution setting
	EPD_4IN2_SendData (0x01);		//400
	EPD_4IN2_SendData (0x90);     	 
	EPD_4IN2_SendData (0x01);		//300
	EPD_4IN2_SendData (0x2c);

	EPD_4IN2_SendCommand(0x82);			//vcom_DC setting
	EPD_4IN2_SendData (0x12);

	EPD_4IN2_SendCommand(0X50);			//VCOM AND DATA INTERVAL SETTING			
	EPD_4IN2_SendData(0x97);
}
/******************************************************************************
function :	Clear screen
parameter:
******************************************************************************/
void EPD_4IN2_Clear(void)
{
    UWORD Width, Height;
    Width = (EPD_4IN2_WIDTH % 8 == 0)? (EPD_4IN2_WIDTH / 8 ): (EPD_4IN2_WIDTH / 8 + 1);
    Height = EPD_4IN2_HEIGHT;

    EPD_4IN2_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN2_SendData(0xFF);
        }
    }

    EPD_4IN2_SendCommand(0x13);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN2_SendData(0xFF);
        }
    }

	EPD_4IN2_SendCommand(0x12);		 //DISPLAY REFRESH 		
	DEV_Delay_ms(1);	
    EPD_4IN2_TurnOnDisplay();
}

/******************************************************************************
function :	Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_4IN2_Display(UBYTE *Image)
{
    UWORD Width, Height;
    Width = (EPD_4IN2_WIDTH % 8 == 0)? (EPD_4IN2_WIDTH / 8 ): (EPD_4IN2_WIDTH / 8 + 1);
    Height = EPD_4IN2_HEIGHT;

	EPD_4IN2_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN2_SendData(0x00);
        }
    }

    EPD_4IN2_SendCommand(0x13);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_4IN2_SendData(Image[i + j * Width]);
        }
    }

	EPD_4IN2_SendCommand(0x12);		 //DISPLAY REFRESH 		
	DEV_Delay_ms(10);		
    EPD_4IN2_TurnOnDisplay();
}

void EPD_4IN2_PartialDisplay(UWORD X_start,UWORD Y_start,UWORD X_end,UWORD Y_end, UBYTE *Image)
{
	UWORD Width, Height;
	static UBYTE DATA[EPD_4IN2_WIDTH * EPD_4IN2_HEIGHT / 8] = {0x00};

    Width = (EPD_4IN2_WIDTH % 8 == 0)? (EPD_4IN2_WIDTH / 8 ): (EPD_4IN2_WIDTH / 8 + 1);
    Height = EPD_4IN2_HEIGHT;
	
	X_start = (X_start % 8 == 0)? (X_start): (X_start/8*8+8);
	X_end = (X_end % 8 == 0)? (X_end): (X_end/8*8+8);
	

	EPD_4IN2_SendCommand(0x91);		//This command makes the display enter partial mode
	EPD_4IN2_SendCommand(0x90);		//resolution setting
	EPD_4IN2_SendData ((X_start)/256);
	EPD_4IN2_SendData ((X_start)%256);   //x-start    

	EPD_4IN2_SendData ((X_end )/256);		
	EPD_4IN2_SendData ((X_end )%256-1);  //x-end

	EPD_4IN2_SendData (Y_start/256);
	EPD_4IN2_SendData (Y_start%256);   //y-start    

	EPD_4IN2_SendData (Y_end/256);		
	EPD_4IN2_SendData (Y_end%256-1);  //y-end
	EPD_4IN2_SendData (0x28);	

	EPD_4IN2_SendCommand(0x10);	       //writes Old data to SRAM for programming
    for (UWORD j = 0; j < Y_end - Y_start; j++) {
        for (UWORD i = 0; i < (X_end - X_start)/8; i++) {
            EPD_4IN2_SendData(DATA[(Y_start + j)*Width + X_start/8 + i]);
        }
    }
	EPD_4IN2_SendCommand(0x13);				 //writes New data to SRAM.
    for (UWORD j = 0; j < Y_end - Y_start; j++) {
        for (UWORD i = 0; i < (X_end - X_start)/8; i++) {
            EPD_4IN2_SendData(~Image[(Y_start + j)*Width + X_start/8 + i]);
			DATA[(Y_start + j)*Width + X_start/8 + i] = ~Image[(Y_start + j)*Width + X_start/8 + i];
        }
    }

	EPD_4IN2_SendCommand(0x12);		 //DISPLAY REFRESH 		             
	DEV_Delay_ms(10);     //The delay here is necessary, 200uS at least!!!     
	EPD_4IN2_TurnOnDisplay();
}

void EPD_4IN2_4GrayDisplay(const UBYTE *Image)
{
    UDOUBLE i,j,k,m;
    UBYTE temp1,temp2,temp3;
/****Color display description****
      white  gray1  gray2  black
0x10|  01     01     00     00
0x13|  01     00     01     00
*********************************/
	EPD_4IN2_SendCommand(0x10);	       
	// EPD_4IN2_HEIGHT
	// EPD_4IN2_WIDTH
	for(m = 0; m<EPD_4IN2_HEIGHT;m++)
		for(i=0;i<EPD_4IN2_WIDTH/8;i++)
		{
			temp3=0;
			for(j=0;j<2;j++)	
			{
				
				temp1 = Image[(m*(EPD_4IN2_WIDTH/8)+i)*2+j];
				for(k=0;k<2;k++)	
				{
					temp2 = temp1&0xC0 ;
					if(temp2 == 0xC0)
						temp3 |= 0x01;//white
					else if(temp2 == 0x00)
						temp3 |= 0x00;  //black
					else if(temp2 == 0x80) 
						temp3 |= 0x01;  //gray1
					else //0x40
						temp3 |= 0x00; //gray2
					temp3 <<= 1;	
					
					temp1 <<= 2;
					temp2 = temp1&0xC0 ;
					if(temp2 == 0xC0)  //white
						temp3 |= 0x01;
					else if(temp2 == 0x00) //black
						temp3 |= 0x00;
					else if(temp2 == 0x80)
						temp3 |= 0x01; //gray1
					else    //0x40
							temp3 |= 0x00;	//gray2	
					if(j!=1 || k!=1)				
						temp3 <<= 1;
					
					temp1 <<= 2;
				}
				
			 }
			EPD_4IN2_SendData(temp3);			
		}
    // new  data
    EPD_4IN2_SendCommand(0x13);	 
	for(m = 0; m<EPD_4IN2_HEIGHT;m++)
		for(i=0;i<EPD_4IN2_WIDTH/8;i++)
		{
			temp3=0;
			for(j=0;j<2;j++)	
			{
				temp1 = Image[(m*(EPD_4IN2_WIDTH/8)+i)*2+j];
				for(k=0;k<2;k++)	
				{
					temp2 = temp1&0xC0 ;
					if(temp2 == 0xC0)
						temp3 |= 0x01;//white
					else if(temp2 == 0x00)
						temp3 |= 0x00;  //black
					else if(temp2 == 0x80) 
						temp3 |= 0x00;  //gray1
					else //0x40
						temp3 |= 0x01; //gray2
					temp3 <<= 1;	
					
					temp1 <<= 2;
					temp2 = temp1&0xC0 ;
					if(temp2 == 0xC0)  //white
						temp3 |= 0x01;
					else if(temp2 == 0x00) //black
						temp3 |= 0x00;
					else if(temp2 == 0x80)
						temp3 |= 0x00; //gray1
					else    //0x40
							temp3 |= 0x01;	//gray2
					if(j!=1 || k!=1)					
						temp3 <<= 1;
					
					temp1 <<= 2;
				}
				
			 }
			EPD_4IN2_SendData(temp3);	
		}
    
    EPD_4IN2_4Gray_lut();
    EPD_4IN2_TurnOnDisplay();
}
/* FrameOS: the Elecrow CrowPanel 4.2" (EPD_4in2_BW, the ESP32's panel table:
 * the board Elecrow ships with its "green sticker" driver, on this
 * controller's command set) in black and white, on the waveforms Elecrow's
 * driver loads for its glass: GC for a full refresh, DU for a partial update
 * that moves only the pixels whose old and new values differ. Waveshare's
 * four-grey table drew its white grey (the bench, 2026-11-26). Each refresh
 * is the controller's own sequence (0x17: power on, refresh, power off). */
static const UBYTE EPD_4in2_bw_init[] = {
    0x00, 2, 0x3F, 0x4D,                   // panel setting: the waveforms from the registers
    0x01, 5, 0x03, 0x10, 0x3F, 0x3F, 0x03, // power setting
    0x06, 3, 0x96, 0x96, 0x29,             // booster soft start
    0x30, 1, 0x09,                         // PLL
    0x61, 4, 0x01, 0x90, 0x01, 0x2C,       // 400 x 300
    0x82, 1, 0x05,                         // VCOM DC
    0x50, 1, 0xD7,                         // VCOM and data interval, border floating
    0x60, 1, 0x22,                         // TCON
    0xE3, 1, 0x88,                         // power saving
};
/* VCOM, WW, BW, WB, BB: each table's first group (the other 35 bytes are 0). */
static const UBYTE EPD_4in2_lut_gc[5][7] = {
    {0x01, 0x14, 0x0A, 0x14, 0x00, 0x01, 0x01}, {0x01, 0x54, 0x0A, 0x94, 0x00, 0x01, 0x01},
    {0x01, 0x54, 0x0A, 0x94, 0x00, 0x01, 0x01}, {0x01, 0x94, 0x0A, 0x54, 0x00, 0x01, 0x01},
    {0x01, 0x94, 0x0A, 0x54, 0x00, 0x01, 0x01},
};
static const UBYTE EPD_4in2_lut_du[5][7] = {
    {0x01, 0x14, 0x00, 0x00, 0x00, 0x01}, {0x01, 0x14, 0x00, 0x00, 0x00, 0x01},
    {0x01, 0x94, 0x00, 0x00, 0x00, 0x01}, {0x01, 0x54, 0x00, 0x00, 0x00, 0x01},
    {0x01, 0x14, 0x00, 0x00, 0x00, 0x01},
};

/* BUSY is low while the controller works. 10 ms a look, counted as 10 ms
 * (a shorter delay sleeps a whole tick on the ESP32). */
static void EPD_4in2_WaitIdle(void)
{
    for (UDOUBLE waited = 0; !DEV_Digital_Read(EPD_BUSY_PIN) && waited < EPD_BUSY_TIMEOUT_MS; waited += 10) {
        DEV_Delay_ms(10);
    }
}

/* One RAM plane (0x10 the old picture, 0x13 the new one), a row a SPI
 * write; NULL is white. */
static void EPD_4in2_SendPlane(UBYTE command, UBYTE *plane)
{
    UBYTE white[EPD_4IN2_WIDTH / 8];
    memset(white, 0xFF, sizeof(white));
    EPD_4IN2_SendCommand(command);
    DEV_Digital_Write(EPD_DC_PIN, 1);
    for (UWORD j = 0; j < EPD_4IN2_HEIGHT; j++) {
        DEV_Digital_Write(EPD_CS_PIN, 0);
        DEV_SPI_Write_nByte(plane ? plane + j * sizeof(white) : white, sizeof(white));
        DEV_Digital_Write(EPD_CS_PIN, 1);
    }
}

static void EPD_4in2_Refresh(const UBYTE lut[5][7])
{
    for (UBYTE r = 0; r < 5; r++) {
        EPD_4IN2_SendCommand(0x20 + r);
        for (UBYTE k = 0; k < 42; k++) EPD_4IN2_SendData(k < 7 ? lut[r][k] : 0x00);
    }
    EPD_4IN2_SendCommand(0x17);
    EPD_4IN2_SendData(0xA5);
    DEV_Delay_ms(1);
    EPD_4in2_WaitIdle();
}

int EPD_4in2_Init_BW(void)
{
    EPD_4IN2_Reset();
    EPD_4in2_WaitIdle();
    for (UWORD i = 0; i < sizeof(EPD_4in2_bw_init); i += 2 + EPD_4in2_bw_init[i + 1]) {
        EPD_4IN2_SendCommand(EPD_4in2_bw_init[i]);
        for (UBYTE k = 0; k < EPD_4in2_bw_init[i + 1]; k++) EPD_4IN2_SendData(EPD_4in2_bw_init[i + 2 + k]);
    }
    return 0;
}

void EPD_4in2_Init_Partial_BW(void)
{
    EPD_4in2_Init_BW();
}

void EPD_4in2_Clear_BW(void)
{
    EPD_4in2_SendPlane(0x10, NULL);
    EPD_4in2_SendPlane(0x13, NULL);
    EPD_4in2_Refresh(EPD_4in2_lut_gc);
}

/* A full refresh: GC drives every pixel whatever the old picture was. */
void EPD_4in2_Display_BW(UBYTE *Image)
{
    EPD_4in2_SendPlane(0x13, Image);
    EPD_4in2_Refresh(EPD_4in2_lut_gc);
}

/* A partial update: the picture on the glass as the old plane, so DU moves
 * only the pixels that change. */
void EPD_4in2_Display_Partial_BW(UBYTE *Image, UBYTE *Previous)
{
    EPD_4in2_SendPlane(0x10, Previous);
    EPD_4in2_SendPlane(0x13, Image);
    EPD_4in2_Refresh(EPD_4in2_lut_du);
}

/* The refresh sequence powered the panel off already; power off again,
 * which is quick, so a rest leaves it off whatever ran before. */
void EPD_4in2_Rest(void)
{
    EPD_4IN2_SendCommand(0x02);
    EPD_4in2_WaitIdle();
}

/******************************************************************************
function :	Enter sleep mode
parameter:
******************************************************************************/
void EPD_4IN2_Sleep(void)
{
	EPD_4IN2_SendCommand(0x50); // DEEP_SLEEP
    EPD_4IN2_SendData(0XF7);

    EPD_4IN2_SendCommand(0x02); // POWER_OFF
    EPD_4IN2_ReadBusy();

    EPD_4IN2_SendCommand(0x07); // DEEP_SLEEP
    EPD_4IN2_SendData(0XA5);
}
