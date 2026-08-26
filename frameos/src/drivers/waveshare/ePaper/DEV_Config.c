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

#include <stdarg.h>
#include <stdlib.h>
#include <time.h>

int GPIO_Handle = -1;
int SPI_Handle = -1;

/**
 * GPIO
**/
int EPD_RST_PIN;
int EPD_DC_PIN;
int EPD_CS_PIN;
int EPD_CS_M_PIN;
int EPD_CS_S_PIN = -1;
int EPD_BUSY_PIN;
int EPD_PWR_PIN;
int EPD_MOSI_PIN;
int EPD_SCLK_PIN;

/* spidev transfers are limited by the kernel's bufsiz module param (4096 by default). */
#define DEV_SPI_CHUNK_BYTES 4096

enum { PIN_RST, PIN_DC, PIN_CS, PIN_CS2, PIN_BUSY, PIN_SCLK, PIN_MOSI, PIN_PWR, PIN_COUNT };
static int s_pin_overrides[PIN_COUNT] = {-1, -1, -1, -1, -1, -1, -1, -1};

void DEV_SetPinConfig(int rst, int dc, int cs, int cs2, int busy, int sclk, int mosi, int pwr)
{
    s_pin_overrides[PIN_RST] = rst;
    s_pin_overrides[PIN_DC] = dc;
    s_pin_overrides[PIN_CS] = cs;
    s_pin_overrides[PIN_CS2] = cs2;
    s_pin_overrides[PIN_BUSY] = busy;
    s_pin_overrides[PIN_SCLK] = sclk;
    s_pin_overrides[PIN_MOSI] = mosi;
    s_pin_overrides[PIN_PWR] = pwr;
}

static void DEV_ApplyPinOverrides(void)
{
    if (s_pin_overrides[PIN_RST] >= 0) EPD_RST_PIN = s_pin_overrides[PIN_RST];
    if (s_pin_overrides[PIN_DC] >= 0) EPD_DC_PIN = s_pin_overrides[PIN_DC];
    if (s_pin_overrides[PIN_CS] >= 0) EPD_CS_PIN = s_pin_overrides[PIN_CS];
    if (s_pin_overrides[PIN_CS2] >= 0) EPD_CS_S_PIN = s_pin_overrides[PIN_CS2];
    if (s_pin_overrides[PIN_BUSY] >= 0) EPD_BUSY_PIN = s_pin_overrides[PIN_BUSY];
    if (s_pin_overrides[PIN_SCLK] >= 0) EPD_SCLK_PIN = s_pin_overrides[PIN_SCLK];
    if (s_pin_overrides[PIN_MOSI] >= 0) EPD_MOSI_PIN = s_pin_overrides[PIN_MOSI];
    if (s_pin_overrides[PIN_PWR] >= 0) EPD_PWR_PIN = s_pin_overrides[PIN_PWR];
    EPD_CS_M_PIN = EPD_CS_PIN;
}

/**
 * Debug logging hook (see DEV_Config.h)
**/
static DEV_DebugLogFn s_debug_log = NULL;

void DEV_SetDebugLog(DEV_DebugLogFn fn)
{
    s_debug_log = fn;
}

int DEV_Debug_Enabled(void)
{
    return s_debug_log != NULL;
}

void DEV_Debug_Log(const char *action, const char *extraJson)
{
    if (s_debug_log != NULL) {
        s_debug_log(action, extraJson);
    }
}

static char s_last_error[256] = "";

void DEV_Error(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    vsnprintf(s_last_error, sizeof(s_last_error), fmt, args);
    va_end(args);
    printf("%s\n", s_last_error);
    fflush(stdout);
    if (s_debug_log != NULL) {
        char extra[300];
        snprintf(extra, sizeof(extra), "\"message\":\"%s\"", s_last_error);
        s_debug_log("error", extra);
    }
}

int DEV_TakeError(char *buf, size_t len)
{
    if (s_last_error[0] == '\0') return 0;
    if (buf != NULL && len > 0) {
        snprintf(buf, len, "%s", s_last_error);
    }
    s_last_error[0] = '\0';
    return 1;
}

/**
 * GPIO read and write
**/
void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    lgGpioWrite(GPIO_Handle, Pin, Value);
}

UBYTE DEV_Digital_Read(UWORD Pin)
{
    int Read_value = lgGpioRead(GPIO_Handle, Pin);
    return Read_value <= 0 ? 0 : (UBYTE)Read_value;
}

/**
 * SPI
**/
/* Bit-banged fallback for when /dev/spidev0.0 could not be opened. Unlike
 * DEV_SPI_SendData this does not touch CS, so it is safe under the drivers'
 * own chip-select handling (including the dual-CS 13.3" panel). */
static void DEV_SPI_BitBangByte(UBYTE Value)
{
    for (int i = 0; i < 8; i++) {
        DEV_Digital_Write(EPD_SCLK_PIN, 0);
        DEV_Digital_Write(EPD_MOSI_PIN, (Value & 0x80) ? 1 : 0);
        DEV_Digital_Write(EPD_SCLK_PIN, 1);
        Value <<= 1;
    }
    DEV_Digital_Write(EPD_SCLK_PIN, 0);
}

void DEV_SPI_WriteByte(uint8_t Value)
{
    if (SPI_Handle < 0) {
        DEV_SPI_BitBangByte(Value);
        return;
    }
    lgSpiWrite(SPI_Handle, (char *)&Value, 1);
}

void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len)
{
    if (pData == NULL || Len == 0) return;
    if (SPI_Handle < 0) {
        for (uint32_t i = 0; i < Len; i++) {
            DEV_SPI_BitBangByte(pData[i]);
        }
        return;
    }
    while (Len > 0) {
        uint32_t chunk = Len > DEV_SPI_CHUNK_BYTES ? DEV_SPI_CHUNK_BYTES : Len;
        lgSpiWrite(SPI_Handle, (char *)pData, chunk);
        pData += chunk;
        Len -= chunk;
    }
}

/**
 * GPIO Mode
**/
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

/**
 * delay x ms
**/
void DEV_Delay_ms(UDOUBLE xms)
{
    lguSleep(xms/1000.0);
}

UDOUBLE DEV_Millis(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (UDOUBLE)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/* Reads up to `cap - 1` bytes of a (proc) file; returns 1 when it contains `needle`. */
static int DEV_File_Contains_N(const char *path, const char *needle, size_t cap)
{
	FILE *fp = fopen(path, "r");
	if (fp == NULL) {
		return 0;
	}
	char *buffer = (char *)malloc(cap);
	if (buffer == NULL) {
		fclose(fp);
		return 0;
	}
	size_t total = 0;
	while (total < cap - 1) {
		size_t got = fread(buffer + total, 1, cap - 1 - total, fp);
		if (got == 0) break;
		total += got;
	}
	fclose(fp);
	buffer[total] = '\0';
	int found = strstr(buffer, needle) != NULL;
	free(buffer);
	return found;
}

static int DEV_File_Contains(const char *path, const char *needle)
{
	return DEV_File_Contains_N(path, needle, 256);
}

static int DEV_Equipment_Testing(void)
{
	FILE *fp;
	char issue_str[64];
	size_t issue_bytes;

	printf("Current environment: ");
	if (DEV_File_Contains("/proc/device-tree/model", "Raspberry Pi")) {
		printf("Raspberry Pi\n");
		return 0;
	}

	issue_str[0] = '\0';
	fp = fopen("/etc/issue", "r");
	if (fp != NULL) {
		issue_bytes = fread(issue_str, 1, sizeof(issue_str) - 1, fp);
		fclose(fp);
		if (issue_bytes > 0) {
			issue_str[issue_bytes] = '\0';
		}
	} else {
		Debug("Unable to open /etc/issue");
	}

	const char *systems[] = {"Raspbian", "Debian", "FrameOS", "Buildroot"};
	int detected = 0;
	for(int i=0; i<4; i++) {
		if (strstr(issue_str, systems[i]) != NULL) {
			printf("%s\n", systems[i]);
			detected = 1;
		}
	}
	if (!detected && (DEV_File_Contains("/etc/os-release", "ID=buildroot") ||
			DEV_File_Contains("/etc/os-release", "NAME=Buildroot"))) {
		printf("Buildroot\n");
		detected = 1;
	}
	if (!detected) {
		printf("not recognized\n");
		printf("Built for Raspberry Pi, but unable to detect environment.\n");
		printf("Perhaps you meant to 'make JETSON' instead?\n");
		return -1;
	}
	return 0;
}

void DEV_GPIO_Init(void)
{
	EPD_RST_PIN     = 17;
	EPD_DC_PIN      = 25;
	EPD_CS_PIN      = 8;
    EPD_CS_S_PIN    = -1;
    EPD_PWR_PIN     = 18;
	EPD_BUSY_PIN    = 24;
    EPD_MOSI_PIN    = 10;
	EPD_SCLK_PIN    = 11;

	DEV_ApplyPinOverrides();

    if (SPI_Handle < 0) {
        // Software SPI fallback: drive clock and data as plain GPIO outputs.
        // With hardware SPI these pins must stay muxed to the SPI peripheral,
        // so claiming them as GPIO here would silently break the transfer.
        DEV_GPIO_Mode(EPD_SCLK_PIN, 1);
        DEV_GPIO_Mode(EPD_MOSI_PIN, 1);
    }
    DEV_GPIO_Mode(EPD_BUSY_PIN, 0);
	DEV_GPIO_Mode(EPD_RST_PIN, 1);
	DEV_GPIO_Mode(EPD_DC_PIN, 1);
	DEV_GPIO_Mode(EPD_CS_PIN, 1);
    if (EPD_CS_S_PIN >= 0) DEV_GPIO_Mode(EPD_CS_S_PIN, 1);
    DEV_GPIO_Mode(EPD_PWR_PIN, 1);

	DEV_Digital_Write(EPD_CS_PIN, 1);
    if (EPD_CS_S_PIN >= 0) DEV_Digital_Write(EPD_CS_S_PIN, 1);
    DEV_Digital_Write(EPD_PWR_PIN, 1);
}

void DEV_SPI_SendnData(UBYTE *Reg)
{
    UDOUBLE size;
    size = sizeof(Reg);
    for(UDOUBLE i=0 ; i<size ; i++)
    {
        DEV_SPI_SendData(Reg[i]);
    }
}

void DEV_SPI_SendData(UBYTE Reg)
{
	UBYTE i,j=Reg;
	DEV_GPIO_Mode(EPD_MOSI_PIN, 1);
	DEV_Digital_Write(EPD_CS_PIN, 0);
	for(i = 0; i<8; i++)
    {
        DEV_Digital_Write(EPD_SCLK_PIN, 0);     
        if (j & 0x80)
        {
            DEV_Digital_Write(EPD_MOSI_PIN, 1);
        }
        else
        {
            DEV_Digital_Write(EPD_MOSI_PIN, 0);
        }
        
        DEV_Digital_Write(EPD_SCLK_PIN, 1);
        j = j << 1;
    }
	DEV_Digital_Write(EPD_SCLK_PIN, 0);
	DEV_Digital_Write(EPD_CS_PIN, 1);
}

UBYTE DEV_SPI_ReadData()
{
	UBYTE i,j=0xff;
	DEV_GPIO_Mode(EPD_MOSI_PIN, 0);
	DEV_Digital_Write(EPD_CS_PIN, 0);
	for(i = 0; i<8; i++)
	{
		DEV_Digital_Write(EPD_SCLK_PIN, 0);
		j = j << 1;
		if (DEV_Digital_Read(EPD_MOSI_PIN))
		{
				j = j | 0x01;
		}
		else
		{
				j= j & 0xfe;
		}
		DEV_Digital_Write(EPD_SCLK_PIN, 1);
	}
	DEV_Digital_Write(EPD_SCLK_PIN, 0);
	DEV_Digital_Write(EPD_CS_PIN, 1);
	return j;
}

/******************************************************************************
function:	Module Initialize, the library and initialize the pins, SPI protocol
parameter:
Info:
******************************************************************************/
UBYTE DEV_Module_Init(void)
{
	if(DEV_Equipment_Testing() < 0) {
		return 1;
	}

    /* Read the model straight from /proc/cpuinfo instead of popen()-ing a
     * shell: the driver runs inside the FrameOS process, and child processes
     * from here have deadlocked frames before. */
    int is_pi5 = DEV_File_Contains_N("/proc/cpuinfo", "Raspberry Pi 5", 64 * 1024);
    int gpio_chip = is_pi5 ? 4 : 0;
    GPIO_Handle = lgGpiochipOpen(gpio_chip);
    if (GPIO_Handle < 0)
    {
        printf("gpiochip%d Export Failed\n", gpio_chip);
        return 1;
    }

    SPI_Handle = lgSpiOpen(0, 0, 10000000, 0);
    if (SPI_Handle < 0) {
        // Bit-banged software SPI is ~7 KB/s (minutes per full frame), so
        // deploys enable spi0 in the boot config; this is only a fallback.
        printf("spidev0.0 unavailable (%d), falling back to software SPI\n", SPI_Handle);
    }
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
    if (EPD_CS_S_PIN >= 0) DEV_Digital_Write(EPD_CS_S_PIN, 0);
    DEV_Digital_Write(EPD_PWR_PIN, 0);
	DEV_Digital_Write(EPD_DC_PIN, 0);
	DEV_Digital_Write(EPD_RST_PIN, 0);
    if (SPI_Handle >= 0) {
        lgSpiClose(SPI_Handle);
        SPI_Handle = -1;
    }
    if (GPIO_Handle >= 0) {
        lgGpiochipClose(GPIO_Handle);
        GPIO_Handle = -1;
    }
}
