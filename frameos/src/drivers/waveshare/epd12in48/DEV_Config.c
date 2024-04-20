/*****************************************************************************
* | File      	:   DEV_Config.c
* | Author      :   Waveshare team
* | Function    :   Hardware underlying interface
* | Info        :
*                Used to shield the underlying layers of each master
*                and enhance portability,software spi.
*----------------
* |	This version:   V1.0
* | Date        :   2018-11-29
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
#include "DEV_Config.h"

int GPIO_Handle;
int SPI_Handle;

SOFTWARE_SPI software_spi;

/******************************************************************************
function:	Write GPIO
parameter:
Info:
******************************************************************************/
void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    lgGpioWrite(GPIO_Handle, Pin, Value);
}

/******************************************************************************
function:	Read Write GPIO
parameter:
Info:   return  IO status
******************************************************************************/
UBYTE DEV_Digital_Read(UWORD Pin)
{
	UBYTE Read_value = 0;
    Read_value = lgGpioRead(GPIO_Handle,Pin);
	return Read_value;
}

/******************************************************************************
function:	Set GPIO mode
parameter:
Info:
******************************************************************************/
void DEV_GPIO_Mode(UWORD Pin, UWORD Mode)
{
    if(Mode == 0 || Mode == LG_SET_INPUT){
        lgGpioClaimInput(GPIO_Handle,LFLAGS,Pin);
        // printf("IN Pin = %d\r\n",Pin);
    }else{
        lgGpioClaimOutput(GPIO_Handle, LFLAGS, Pin, LG_LOW);
        // printf("OUT Pin = %d\r\n",Pin);
    }
}

/******************************************************************************
function:	Initialization pin
parameter:
Info:
******************************************************************************/
static void DEV_GPIOConfig(void)
{
    //output
	DEV_GPIO_Mode(EPD_SCK_PIN, 1);
    DEV_GPIO_Mode(EPD_MOSI_PIN, 1);

    DEV_GPIO_Mode(EPD_M1_CS_PIN, 1);
    DEV_GPIO_Mode(EPD_S1_CS_PIN, 1);
    DEV_GPIO_Mode(EPD_M2_CS_PIN, 1);
    DEV_GPIO_Mode(EPD_S2_CS_PIN, 1);

    DEV_GPIO_Mode(EPD_M1S1_DC_PIN, 1);
    DEV_GPIO_Mode(EPD_M2S2_DC_PIN, 1);

    DEV_GPIO_Mode(EPD_M1S1_RST_PIN, 1);
    DEV_GPIO_Mode(EPD_M2S2_RST_PIN, 1);

    //intput
    DEV_GPIO_Mode(EPD_M1_BUSY_PIN, 0);
    DEV_GPIO_Mode(EPD_S1_BUSY_PIN, 0);
    DEV_GPIO_Mode(EPD_M2_BUSY_PIN, 0);
    DEV_GPIO_Mode(EPD_S2_BUSY_PIN, 0);

	DEV_Digital_Write(EPD_SCK_PIN, 0);
    DEV_Digital_Write(EPD_MOSI_PIN, 0);

	DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);

    DEV_Digital_Write(EPD_M2S2_RST_PIN, 0);
    DEV_Digital_Write(EPD_M1S1_RST_PIN, 0);
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 1);
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 1);

}

/******************************************************************************
function:	Module Initialize, the BCM2835 library and initialize the pins, SPI protocol
parameter:
Info:
******************************************************************************/
UBYTE DEV_ModuleInit(void)
{
    char buffer[NUM_MAXBUF];
    FILE *fp;

    fp = popen("cat /proc/cpuinfo | grep 'Raspberry Pi 5'", "r");
    if (fp == NULL) {
        printf("It is not possible to determine the model of the Raspberry PI\n");
        return -1;
    }

    if(fgets(buffer, sizeof(buffer), fp) != NULL)
    {
        GPIO_Handle = lgGpiochipOpen(4);
        if (GPIO_Handle < 0)
        {
            printf( "gpiochip4 Export Failed\n");
            return -1;
        }
    }
    else
    {
        GPIO_Handle = lgGpiochipOpen(0);
        if (GPIO_Handle < 0)
        {
            printf( "gpiochip0 Export Failed\n");
            return -1;
        }
    }
    //software spi configure
    software_spi.SCLK_PIN = EPD_SCK_PIN;
    software_spi.MOSI_PIN = EPD_MOSI_PIN;
    software_spi.Mode = Mode0;
    software_spi.Type = Master;
    software_spi.Clock = 10;

	DEV_GPIOConfig();
    return 0;
}

/******************************************************************************
function:	Microsecond delay
parameter:
Info:
******************************************************************************/
void DEV_Delay_us(UWORD xus)
{
    UWORD i;
    while(xus) {
        for(i = 0; i < software_spi.Clock; i++);
        xus--;
    }
}

/**
 * delay x ms
**/
void DEV_Delay_ms(UDOUBLE xms)
{
    lguSleep(xms/1000.0);
}

/******************************************************************************
function:	SPI Mode 0
parameter:
Info:
******************************************************************************/
void DEV_SPI_WriteByte(UBYTE value)
{
    char i;
    DEV_Delay_us(5);
    switch(software_spi.Mode) {
    case Mode0: /* Clock Polarity is 0 and Clock Phase is 0 */
        DEV_Digital_Write(software_spi.SCLK_PIN, 0);
        for(i = 0; i < 8; i++) {
            DEV_Digital_Write(software_spi.SCLK_PIN, 0);
            DEV_Delay_us(10);
            if(value  & 0x80) {
                DEV_Digital_Write(software_spi.MOSI_PIN, 1);
            } else {
                DEV_Digital_Write(software_spi.MOSI_PIN, 0);
            }
            value = value << 1;
            DEV_Delay_us(10);
            DEV_Digital_Write(software_spi.SCLK_PIN, 1);
            DEV_Delay_us(10);
        }
        break;
    case Mode1: /* Clock Polarity is 0 and Clock Phase is 1 */
        DEV_Digital_Write(software_spi.SCLK_PIN, 0);
        for(i = 0; i < 8; i++) {
            DEV_Digital_Write(software_spi.SCLK_PIN, 1);
            if((value << i) & 0x80) {
                DEV_Digital_Write(software_spi.MOSI_PIN, 1);
            } else {
                DEV_Digital_Write(software_spi.MOSI_PIN, 0);
            }
            DEV_Delay_us(5);
            DEV_Digital_Write(software_spi.SCLK_PIN, 0);
            DEV_Delay_us(5);
        }
        DEV_Digital_Write(software_spi.SCLK_PIN, 0);
        break;
    case Mode2: /* Clock Polarity is 1 and Clock Phase is 0 */
        DEV_Digital_Write(software_spi.SCLK_PIN, 1);
        for(i = 0; i < 8; i++) {
            DEV_Digital_Write(software_spi.SCLK_PIN, 1);
            if((value << i) & 0x80) {
                DEV_Digital_Write(software_spi.MOSI_PIN, 1);
            } else {
                DEV_Digital_Write(software_spi.MOSI_PIN, 0);
            }
            DEV_Delay_us(5);
            DEV_Digital_Write(software_spi.SCLK_PIN, 0);
            DEV_Delay_us(5);
        }
        DEV_Digital_Write(software_spi.SCLK_PIN, 1);
        break;
    case Mode3: /* Clock Polarity is 1 and Clock Phase is 1 */
        DEV_Digital_Write(software_spi.SCLK_PIN, 1);
        for(i = 0; i < 8; i++) {
            DEV_Digital_Write(software_spi.SCLK_PIN, 0);
            if((value << i) & 0x80) {
                DEV_Digital_Write(software_spi.MOSI_PIN, 1);
            } else {
                DEV_Digital_Write(software_spi.MOSI_PIN, 0);
            }
            DEV_Delay_us(5);
            DEV_Digital_Write(software_spi.SCLK_PIN, 1);
            DEV_Delay_us(5);
        }
        DEV_Digital_Write(software_spi.SCLK_PIN, 1);
        break;
    default:
        break;
    }
}

UBYTE DEV_SPI_ReadByte(UBYTE Reg)
{
    unsigned char i,j;
    //set mosi pin intput
    DEV_GPIO_Mode(software_spi.MOSI_PIN, 0);
    j=0;
    DEV_Delay_us(5);
    for(i = 0; i < 8; i++) {
        DEV_Digital_Write(software_spi.SCLK_PIN, 0);
        DEV_Delay_us(10);
        j = j << 1;
        if(DEV_Digital_Read(software_spi.MOSI_PIN) == 1)
            j |= 0x01;
        else
            j &= 0xfe;
        DEV_Delay_us(10);
        DEV_Digital_Write(software_spi.SCLK_PIN, 1);
        DEV_Delay_us(10);
    }

    //set mosi pin output
    DEV_GPIO_Mode(software_spi.MOSI_PIN, 1);
    return j;
}

/******************************************************************************
function:	Module exits, closes SPI and BCM2835 library
parameter:
Info:
******************************************************************************/
void DEV_ModuleExit(void)
{
	DEV_Digital_Write(EPD_M1S1_RST_PIN, 0);
	DEV_Digital_Write(EPD_M2S2_RST_PIN, 0);
    DEV_Digital_Write(EPD_M1S1_RST_PIN, 0);
    DEV_Digital_Write(EPD_M2S2_DC_PIN, 0);
    DEV_Digital_Write(EPD_M1S1_DC_PIN, 0);
    DEV_Digital_Write(EPD_S1_CS_PIN, 1);
    DEV_Digital_Write(EPD_S2_CS_PIN, 1);
    DEV_Digital_Write(EPD_M1_CS_PIN, 1);
    DEV_Digital_Write(EPD_M2_CS_PIN, 1);
    // lgGpiochipClose(GPIO_Handle);
}