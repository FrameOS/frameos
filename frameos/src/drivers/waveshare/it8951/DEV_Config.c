/*****************************************************************************
* | File      	:   DEV_Config.c
* | Author      :   Waveshare team
* | Function    :   Hardware underlying interface
* | Info        :
*----------------
* |	This version:   V3.0
* | Date        :   2019-09-17
* | Info        :   
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of theex Software, and to permit persons to  whom the Software is
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
#include "DEV_Config.h"
#include <fcntl.h>

int GPIO_Handle;
int SPI_Handle;

/******************************************************************************
function:	GPIO Write
parameter:
Info:
******************************************************************************/
void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    lgGpioWrite(GPIO_Handle, Pin, Value);
}

/******************************************************************************
function:	GPIO Read
parameter:
Info:
******************************************************************************/
UBYTE DEV_Digital_Read(UWORD Pin)
{
	UBYTE Read_Value = 0;
    Read_Value = lgGpioRead(GPIO_Handle,Pin);
	return Read_Value;
}

/******************************************************************************
function:	SPI Write
parameter:
Info:
******************************************************************************/
void DEV_SPI_WriteByte(UBYTE Value)
{
    lgSpiWrite(SPI_Handle,(char*)&Value, 1);
}

/******************************************************************************
function:	SPI Read
parameter:
Info:
******************************************************************************/
UBYTE DEV_SPI_ReadByte()
{
	UBYTE Read_Value = 0x00;
    lgSpiRead(SPI_Handle, (char*)&Read_Value, 1);
	return Read_Value;
}

/******************************************************************************
function:	Time delay for ms
parameter:
Info:
******************************************************************************/
void DEV_Delay_ms(UDOUBLE xms)
{
    lguSleep(xms/1000.0);
}


/******************************************************************************
function:	Time delay for us
parameter:
Info:
******************************************************************************/
void DEV_Delay_us(UDOUBLE xus)
{
    lguSleep(xus/1000000.0);
}


/**
 * GPIO Mode
**/
static void DEV_GPIO_Mode(UWORD Pin, UWORD Mode)
{
    if(Mode == 0 || Mode == LG_SET_INPUT){
        lgGpioClaimInput(GPIO_Handle,LFLAGS,Pin);
        // Debug("IN Pin = %d\r\n",Pin);
    }else{
        lgGpioClaimOutput(GPIO_Handle, LFLAGS, Pin, LG_LOW);
        // Debug("OUT Pin = %d\r\n",Pin);
    }
}


/**
 * GPIO Init
**/
static void DEV_GPIO_Init(void)
{
	DEV_GPIO_Mode(EPD_BUSY_PIN, 0);
	DEV_GPIO_Mode(EPD_RST_PIN, 1);
    DEV_GPIO_Mode(EPD_CS_PIN, 1);

    DEV_Digital_Write(EPD_CS_PIN, 1);	
}



/******************************************************************************
function:	Module Initialize, the library and initialize the pins, SPI protocol
parameter:
Info:
******************************************************************************/
UBYTE DEV_Module_Init(void)
{
    Debug("/***********************************/ \r\n");

    char buffer[NUM_MAXBUF];
    FILE *fp;

    fp = popen("cat /proc/cpuinfo | grep 'Raspberry Pi 5'", "r");
    if (fp == NULL) {
        Debug("It is not possible to determine the model of the Raspberry PI\n");
        return -1;
    }

    if(fgets(buffer, sizeof(buffer), fp) != NULL)
    {
        GPIO_Handle = lgGpiochipOpen(4);
        if (GPIO_Handle < 0)
        {
            Debug( "gpiochip4 Export Failed\n");
            return -1;
        }
    }
    else
    {
        GPIO_Handle = lgGpiochipOpen(0);
        if (GPIO_Handle < 0)
        {
            Debug( "gpiochip0 Export Failed\n");
            return -1;
        }
    }
    SPI_Handle = lgSpiOpen(0, 0, 12500000, 0);
    DEV_GPIO_Init();
    Debug("/***********************************/!! \r\n");
	return 0;
}



/******************************************************************************
function:	Module exits, closes SPI and BCM2835 library
parameter:
Info:
******************************************************************************/
void DEV_Module_Exit(void)
{
    // DEV_Digital_Write(EPD_CS_PIN, 0);
	// DEV_Digital_Write(EPD_RST_PIN, 0);
    // lgSpiClose(SPI_Handle);
    // lgGpiochipClose(GPIO_Handle);
}
