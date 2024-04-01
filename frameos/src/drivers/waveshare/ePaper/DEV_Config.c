/*****************************************************************************
* | File      	:   DEV_Config.c
* | Author      :   Waveshare team
* | Function    :   Hardware underlying interface
* | Info        :
*----------------
* |	This version:   V3.0
* | Date        :   2019-07-31
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
#include "Debug.h"

int GPIO_Handle;
int SPI_Handle;

/**
 * GPIO
 **/
int EPD_RST_PIN;
int EPD_DC_PIN;
int EPD_CS_PIN;
int EPD_BUSY_PIN;
int EPD_PWR_PIN;

UWORD EPD_M1_CS_PIN;
UWORD EPD_S1_CS_PIN;
UWORD EPD_M2_CS_PIN;
UWORD EPD_S2_CS_PIN;

UWORD EPD_M1S1_DC_PIN;
UWORD EPD_M2S2_DC_PIN;

UWORD EPD_M1S1_RST_PIN;
UWORD EPD_M2S2_RST_PIN;

UWORD EPD_M1_BUSY_PIN;
UWORD EPD_S1_BUSY_PIN;
UWORD EPD_M2_BUSY_PIN;
UWORD EPD_S2_BUSY_PIN;

/**
 * GPIO read and write
 **/
void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    lgGpioWrite(GPIO_Handle, Pin, Value);
}

UBYTE DEV_Digital_Read(UWORD Pin)
{
    UBYTE Read_value = 0;
    Read_value = lgGpioRead(GPIO_Handle, Pin);
    return Read_value;
}

/**
 * SPI
 **/
void DEV_SPI_WriteByte(uint8_t Value)
{
    lgSpiWrite(SPI_Handle, (char *)&Value, 1);
}

void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len)
{
    lgSpiWrite(SPI_Handle, (char *)pData, Len);
}

/**
 * GPIO Mode
 **/
void DEV_GPIO_Mode(UWORD Pin, UWORD Mode)
{
    if (Mode == 0 || Mode == LG_SET_INPUT)
    {
        lgGpioClaimInput(GPIO_Handle, LFLAGS, Pin);
        // printf("IN Pin = %d\r\n",Pin);
    }
    else
    {
        lgGpioClaimOutput(GPIO_Handle, LFLAGS, Pin, LG_LOW);
        // printf("OUT Pin = %d\r\n",Pin);
    }
}

/**
 * delay x ms
 **/
void DEV_Delay_ms(UDOUBLE xms)
{
    lguSleep(xms / 1000.0);
}

static int DEV_Equipment_Testing(void)
{
    FILE *fp;
    char issue_str[64];

    fp = fopen("/etc/issue", "r");
    if (fp == NULL)
    {
        Debug("Unable to open /etc/issue");
        return -1;
    }
    if (fread(issue_str, 1, sizeof(issue_str), fp) <= 0)
    {
        Debug("Unable to read from /etc/issue");
        return -1;
    }
    issue_str[sizeof(issue_str) - 1] = '\0';
    fclose(fp);

    printf("Current environment: ");

    char systems[][9] = {"Raspbian", "Debian", "NixOS"};
    int detected = 0;
    for (int i = 0; i < 3; i++)
    {
        if (strstr(issue_str, systems[i]) != NULL)
        {
            printf("%s\n", systems[i]);
            detected = 1;
        }
    }
    if (!detected)
    {
        printf("not recognized\n");
        printf("Built for Raspberry Pi, but unable to detect environment.\n");
        printf("Perhaps you meant to 'make JETSON' instead?\n");
        return -1;
    }

    return 0;
}

void DEV_GPIO_Init(void)
{
    EPD_RST_PIN = 17;
    EPD_DC_PIN = 25;
    EPD_CS_PIN = 8;
    EPD_PWR_PIN = 18;
    EPD_BUSY_PIN = 24;

    DEV_GPIO_Mode(EPD_BUSY_PIN, 0);
    DEV_GPIO_Mode(EPD_RST_PIN, 1);
    DEV_GPIO_Mode(EPD_DC_PIN, 1);
    DEV_GPIO_Mode(EPD_CS_PIN, 1);
    DEV_GPIO_Mode(EPD_PWR_PIN, 1);

    DEV_Digital_Write(EPD_CS_PIN, 1);
    DEV_Digital_Write(EPD_PWR_PIN, 1);
}
/******************************************************************************
function:	Module Initialize, the library and initialize the pins, SPI protocol
parameter:
Info:
******************************************************************************/
UBYTE DEV_Module_Init(void)
{
    if (DEV_Equipment_Testing() < 0)
    {
        return 1;
    }

    char buffer[NUM_MAXBUF];
    FILE *fp;

    fp = popen("cat /proc/cpuinfo | grep 'Raspberry Pi 5'", "r");
    if (fp == NULL)
    {
        Debug("It is not possible to determine the model of the Raspberry PI\n");
        return -1;
    }

    if (fgets(buffer, sizeof(buffer), fp) != NULL)
    {
        GPIO_Handle = lgGpiochipOpen(4);
        if (GPIO_Handle < 0)
        {
            Debug("gpiochip4 Export Failed\n");
            return -1;
        }
    }
    else
    {
        GPIO_Handle = lgGpiochipOpen(0);
        if (GPIO_Handle < 0)
        {
            Debug("gpiochip0 Export Failed\n");
            return -1;
        }
    }
    SPI_Handle = lgSpiOpen(0, 0, 10000000, 0);
    DEV_GPIO_Init();
    return 0;
}

/******************************************************************************
function:	Module exits, closes SPI and BCM2835 library
parameter:
Info:
******************************************************************************/
void DEV_Module_Exit(void)
{
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_Digital_Write(EPD_PWR_PIN, 0);
    DEV_Digital_Write(EPD_DC_PIN, 0);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    lgSpiClose(SPI_Handle);
    lgGpiochipClose(GPIO_Handle);
}
