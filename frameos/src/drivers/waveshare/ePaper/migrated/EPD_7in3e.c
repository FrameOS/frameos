/*****************************************************************************
* | File        :   EPD_7in3e.c
* | Author      :   Waveshare team
* | Function    :   7.3inch e-Paper (F) Driver
* | Info        :
*----------------
* | This version:   V1.0
* | Date        :   2022-10-20
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
#include "EPD_7in3e.h"
#include "Debug.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static void log_with_timestamp(const char *category, const char *message)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm_info;
    struct tm *tm_ptr = localtime(&tv.tv_sec);
    if (tm_ptr != NULL) {
        tm_info = *tm_ptr;
    } else {
        memset(&tm_info, 0, sizeof(tm_info));
    }

    char time_buf[64];
    strftime(time_buf, sizeof(time_buf), "%Y-%m-%d %H:%M:%S", &tm_info);

    printf("[%s.%03ld] %s%s%s\n", time_buf, tv.tv_usec / 1000,
           category != NULL ? category : "",
           (category != NULL && message != NULL) ? " " : "",
           message != NULL ? message : "");
    fflush(stdout);
}

static void log_debug_action_extra(const char *action, const char *extra)
{
    char buffer[256];
    if (extra && extra[0] != '\0') {
        snprintf(buffer, sizeof(buffer), "action=\"%s\" %s", action, extra);
    } else {
        snprintf(buffer, sizeof(buffer), "action=\"%s\"", action);
    }
    log_with_timestamp("driver:waveshare:debug", buffer);
}

static void log_debug_action(const char *action)
{
    log_debug_action_extra(action, NULL);
}

static int data_log_counter = 0;
static int data_bytes_current_command = 0;

static void log_command(UBYTE reg)
{
    data_log_counter = 0;
    data_bytes_current_command = 0;

    char buffer[128];
    snprintf(buffer, sizeof(buffer), "command=%u commandHex=0x%02X",
             (unsigned int)reg, (unsigned int)reg);
    log_with_timestamp("driver:waveshare:command", buffer);
}

static void log_data(UBYTE data)
{
    ++data_bytes_current_command;

    if (data_log_counter < 16) {
        char buffer[160];
        snprintf(buffer, sizeof(buffer),
                 "index=%d data=%u dataHex=0x%02X",
                 data_bytes_current_command,
                 (unsigned int)data,
                 (unsigned int)data);
        log_with_timestamp("driver:waveshare:data", buffer);
    } else if (data_log_counter == 16) {
        char buffer[160];
        snprintf(buffer, sizeof(buffer),
                 "message=\"Further data logging suppressed for this command\" bytesSent=%d",
                 data_bytes_current_command);
        log_with_timestamp("driver:waveshare:data", buffer);
    } else if (data_bytes_current_command % 4096 == 0) {
        char buffer[160];
        snprintf(buffer, sizeof(buffer),
                 "message=\"Data transfer progress\" bytesSent=%d",
                 data_bytes_current_command);
        log_with_timestamp("driver:waveshare:data", buffer);
    }

    ++data_log_counter;
}

static long elapsed_ms(const struct timeval *start, const struct timeval *end)
{
    long seconds = (long)(end->tv_sec - start->tv_sec);
    long useconds = (long)(end->tv_usec - start->tv_usec);
    return seconds * 1000 + useconds / 1000;
}

/******************************************************************************
function :  Software reset
parameter:
******************************************************************************/
static void EPD_7IN3E_Reset(void)
{
    log_debug_action("reset:start");
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(2);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(20);
    log_debug_action("reset:done");
}

/******************************************************************************
function :  send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_7IN3E_SendCommand(UBYTE Reg)
{
    log_command(Reg);
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
static void EPD_7IN3E_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);

    log_data(Data);
}

/******************************************************************************
function :  Wait until the busy_pin goes LOW
parameter:
******************************************************************************/
static void EPD_7IN3E_ReadBusyH(void)
{
    struct timeval start_tv;
    gettimeofday(&start_tv, NULL);

    UBYTE state = DEV_Digital_Read(EPD_BUSY_PIN);
    char start_buffer[128];
    snprintf(start_buffer, sizeof(start_buffer), "initialState=%u",
             (unsigned int)state);
    log_debug_action_extra("busy:wait:start", start_buffer);

    long loop_count = 0;
    int observed_low = (state == 0);
    struct timeval low_start_tv = start_tv;
    struct timeval last_log_tv = start_tv;

    if (!observed_low && state == 0) {
        observed_low = 1;
        gettimeofday(&low_start_tv, NULL);
    }

    while(!DEV_Digital_Read(EPD_BUSY_PIN)) {      //LOW: busy, HIGH: idle
        if (!observed_low) {
            observed_low = 1;
            gettimeofday(&low_start_tv, NULL);
        }

        DEV_Delay_ms(1);
        ++loop_count;

        if (loop_count % 1000 == 0) {
            struct timeval now;
            gettimeofday(&now, NULL);
            long elapsed = elapsed_ms(&start_tv, &now);
            long since_last = elapsed_ms(&last_log_tv, &now);
            if (since_last >= 1000) {
                char buffer[160];
                snprintf(buffer, sizeof(buffer),
                         "loops=%ld elapsedMs=%ld stage=\"waitForHigh\"",
                         loop_count, elapsed);
                log_with_timestamp("driver:waveshare:busy", buffer);
                last_log_tv = now;
            }
        }
    }

    struct timeval end_tv;
    gettimeofday(&end_tv, NULL);

    long duration = elapsed_ms(&start_tv, &end_tv);
    long waited_for_low_ms = 0;
    long waited_for_high_ms = 0;
    if (observed_low) {
        waited_for_low_ms = elapsed_ms(&start_tv, &low_start_tv);
        waited_for_high_ms = elapsed_ms(&low_start_tv, &end_tv);
    }

    state = DEV_Digital_Read(EPD_BUSY_PIN);

    char end_buffer[256];
    snprintf(end_buffer, sizeof(end_buffer),
             "durationMs=%ld loops=%ld finalState=%u observedLow=%s waitedForLowMs=%ld waitedForHighMs=%ld timedOutWaitingForLow=false",
             duration,
             loop_count,
             (unsigned int)state,
             observed_low ? "true" : "false",
             waited_for_low_ms,
             waited_for_high_ms);
    log_debug_action_extra("busy:wait:end", end_buffer);
}

/******************************************************************************
function :  Turn On Display
parameter:
******************************************************************************/
static void EPD_7IN3E_TurnOnDisplay(void)
{
    log_debug_action("turnOnDisplay:start");

    log_debug_action("turnOnDisplay:powerOn");
    EPD_7IN3E_SendCommand(0x04); // POWER_ON
    EPD_7IN3E_ReadBusyH();

    //Second setting
    log_debug_action("turnOnDisplay:secondSetting");
    EPD_7IN3E_SendCommand(0x06);
    EPD_7IN3E_SendData(0x6F);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x17);
    EPD_7IN3E_SendData(0x49);

    log_debug_action("turnOnDisplay:refresh");
    EPD_7IN3E_SendCommand(0x12); // DISPLAY_REFRESH
    EPD_7IN3E_SendData(0x00);
    EPD_7IN3E_ReadBusyH();

    log_debug_action("turnOnDisplay:powerOff");
    EPD_7IN3E_SendCommand(0x02); // POWER_OFF
    EPD_7IN3E_SendData(0X00);
    EPD_7IN3E_ReadBusyH();

    log_debug_action("turnOnDisplay:done");
}

/******************************************************************************
function :  Initialize the e-Paper register
parameter:
******************************************************************************/
void EPD_7IN3E_Init(void)
{
    log_debug_action("init:start");
    EPD_7IN3E_Reset();
    EPD_7IN3E_ReadBusyH();
    DEV_Delay_ms(30);
    log_debug_action("init:afterResetDelay");

    log_debug_action("init:cmdh");
    EPD_7IN3E_SendCommand(0xAA);    // CMDH
    EPD_7IN3E_SendData(0x49);
    EPD_7IN3E_SendData(0x55);
    EPD_7IN3E_SendData(0x20);
    EPD_7IN3E_SendData(0x08);
    EPD_7IN3E_SendData(0x09);
    EPD_7IN3E_SendData(0x18);

    log_debug_action("init:drvPLL");
    EPD_7IN3E_SendCommand(0x01);//
    EPD_7IN3E_SendData(0x3F);

    log_debug_action("init:powerSetting");
    EPD_7IN3E_SendCommand(0x00);
    EPD_7IN3E_SendData(0x5F);
    EPD_7IN3E_SendData(0x69);

    log_debug_action("init:boosterSoftStart");
    EPD_7IN3E_SendCommand(0x03);
    EPD_7IN3E_SendData(0x00);
    EPD_7IN3E_SendData(0x54);
    EPD_7IN3E_SendData(0x00);
    EPD_7IN3E_SendData(0x44);

    log_debug_action("init:powerOptimisation1");
    EPD_7IN3E_SendCommand(0x05);
    EPD_7IN3E_SendData(0x40);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x2C);

    log_debug_action("init:powerOptimisation2");
    EPD_7IN3E_SendCommand(0x06);
    EPD_7IN3E_SendData(0x6F);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x17);
    EPD_7IN3E_SendData(0x49);

    log_debug_action("init:powerOptimisation3");
    EPD_7IN3E_SendCommand(0x08);
    EPD_7IN3E_SendData(0x6F);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x1F);
    EPD_7IN3E_SendData(0x22);

    log_debug_action("init:powerOptimisation4");
    EPD_7IN3E_SendCommand(0x30);
    EPD_7IN3E_SendData(0x03);

    log_debug_action("init:vcomAndDataInterval");
    EPD_7IN3E_SendCommand(0x50);
    EPD_7IN3E_SendData(0x3F);

    log_debug_action("init:resolution");
    EPD_7IN3E_SendCommand(0x60);
    EPD_7IN3E_SendData(0x02);
    EPD_7IN3E_SendData(0x00);

    EPD_7IN3E_SendCommand(0x61);
    EPD_7IN3E_SendData(0x03);
    EPD_7IN3E_SendData(0x20);
    EPD_7IN3E_SendData(0x01);
    EPD_7IN3E_SendData(0xE0);

    log_debug_action("init:vdcsSetting");
    EPD_7IN3E_SendCommand(0x84);
    EPD_7IN3E_SendData(0x01);

    log_debug_action("init:pllControl");
    EPD_7IN3E_SendCommand(0xE3);
    EPD_7IN3E_SendData(0x2F);

    log_debug_action("init:powerOn");
    EPD_7IN3E_SendCommand(0x04);     //PWR on
    EPD_7IN3E_ReadBusyH();          //waiting for the electronic paper IC to release the idle signal

    log_debug_action("init:done");
}

/******************************************************************************
function :  Clear screen
parameter:
******************************************************************************/
void EPD_7IN3E_Clear(UBYTE color)
{
    UWORD Width, Height;
    Width = (EPD_7IN3E_WIDTH % 2 == 0)? (EPD_7IN3E_WIDTH / 2 ): (EPD_7IN3E_WIDTH / 2 + 1);
    Height = EPD_7IN3E_HEIGHT;

    unsigned long total_bytes = (unsigned long)Width * (unsigned long)Height;
    char start_buffer[160];
    snprintf(start_buffer, sizeof(start_buffer),
             "color=%u widthBytes=%u height=%u totalBytes=%lu",
             (unsigned int)color, Width, Height, total_bytes);
    log_debug_action_extra("clear:start", start_buffer);

    EPD_7IN3E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_7IN3E_SendData((color<<4)|color);
        }
    }

    char end_buffer[128];
    snprintf(end_buffer, sizeof(end_buffer), "totalBytes=%lu", total_bytes);
    log_debug_action_extra("clear:dataWritten", end_buffer);
    EPD_7IN3E_TurnOnDisplay();
}

/******************************************************************************
function :  show 7 kind of color block
parameter:
******************************************************************************/
void EPD_7IN3E_Show7Block(void)
{
    unsigned long i, j, k;
    unsigned char const Color_seven[6] =
    {EPD_7IN3E_BLACK, EPD_7IN3E_YELLOW, EPD_7IN3E_RED, EPD_7IN3E_BLUE, EPD_7IN3E_GREEN, EPD_7IN3E_WHITE};

    log_debug_action_extra("show7Block:start", "blocks=6 bytesPerBlock=20000");

    EPD_7IN3E_SendCommand(0x10);
    for(k = 0 ; k < 6; k ++) {
        for(j = 0 ; j < 20000; j ++) {
            EPD_7IN3E_SendData((Color_seven[k]<<4) |Color_seven[k]);
        }
    }
    log_debug_action_extra("show7Block:dataWritten", "totalBytes=120000");
    EPD_7IN3E_TurnOnDisplay();
}

void EPD_7IN3E_Show(void)
{
    unsigned long k,o;
    unsigned char const Color_seven[6] = 
    {EPD_7IN3E_BLACK, EPD_7IN3E_YELLOW, EPD_7IN3E_RED, EPD_7IN3E_BLUE, EPD_7IN3E_GREEN, EPD_7IN3E_WHITE};

    UWORD Width, Height;
    Width = (EPD_7IN3E_WIDTH % 2 == 0)? (EPD_7IN3E_WIDTH / 2 ): (EPD_7IN3E_WIDTH / 2 + 1);
    Height = EPD_7IN3E_HEIGHT;
    k = 0;
    o = 0;

    unsigned long total_bytes = (unsigned long)Width * (unsigned long)Height;
    char start_buffer[160];
    snprintf(start_buffer, sizeof(start_buffer),
             "widthBytes=%u height=%u totalBytes=%lu", Width, Height, total_bytes);
    log_debug_action_extra("show:start", start_buffer);

    EPD_7IN3E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        if((j > 10) && (j<50))
        for (UWORD i = 0; i < Width; i++) {
                EPD_7IN3E_SendData((Color_seven[0]<<4) |Color_seven[0]);
            }
        else if(o < Height/2)
        for (UWORD i = 0; i < Width; i++) {
                EPD_7IN3E_SendData((Color_seven[0]<<4) |Color_seven[0]);
            }
        
        else
        {
            for (UWORD i = 0; i < Width; i++) {
                EPD_7IN3E_SendData((Color_seven[k]<<4) |Color_seven[k]);
                
            }
            k++ ;
            if(k >= 6)
                k = 0;
        }
            
        o++ ;
        if(o >= Height)
            o = 0;
    }
    char data_buffer[128];
    snprintf(data_buffer, sizeof(data_buffer), "totalBytes=%lu", total_bytes);
    log_debug_action_extra("show:dataWritten", data_buffer);
    EPD_7IN3E_TurnOnDisplay();
}

/******************************************************************************
function :  Sends the image buffer in RAM to e-Paper and displays
parameter:
******************************************************************************/
void EPD_7IN3E_Display(UBYTE *Image)
{
    UWORD Width, Height;
    Width = (EPD_7IN3E_WIDTH % 2 == 0)? (EPD_7IN3E_WIDTH / 2 ): (EPD_7IN3E_WIDTH / 2 + 1);
    Height = EPD_7IN3E_HEIGHT;

    if (Image == NULL) {
        log_debug_action("display:image:nil");
        return;
    }

    unsigned long total_bytes = (unsigned long)Width * (unsigned long)Height;
    char start_buffer[160];
    snprintf(start_buffer, sizeof(start_buffer),
             "widthBytes=%u height=%u totalBytes=%lu", Width, Height, total_bytes);
    log_debug_action_extra("display:start", start_buffer);

    if (total_bytes > 0) {
        int preview_count = (total_bytes < 16) ? (int)total_bytes : 16;
        char bytes_buffer[256];
        int offset = snprintf(bytes_buffer, sizeof(bytes_buffer), "[");
        for (int idx = 0; idx < preview_count && offset < (int)sizeof(bytes_buffer); ++idx) {
            int written = snprintf(bytes_buffer + offset, sizeof(bytes_buffer) - (size_t)offset,
                                   "%s%u", idx == 0 ? "" : ",",
                                   (unsigned int)Image[idx]);
            if (written < 0) {
                break;
            }
            offset += written;
        }
        if (offset < (int)sizeof(bytes_buffer) - 2) {
            snprintf(bytes_buffer + offset, sizeof(bytes_buffer) - (size_t)offset, "]");
        } else {
            bytes_buffer[sizeof(bytes_buffer) - 2] = ']';
            bytes_buffer[sizeof(bytes_buffer) - 1] = '\0';
        }

        char preview_message[320];
        snprintf(preview_message, sizeof(preview_message),
                 "count=%d bytes=%s", preview_count, bytes_buffer);
        log_with_timestamp("driver:waveshare:dataPreview", preview_message);
    }

    EPD_7IN3E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_7IN3E_SendData(Image[i + j * Width]);
        }
    }
    char end_buffer[128];
    snprintf(end_buffer, sizeof(end_buffer), "totalBytes=%lu", total_bytes);
    log_debug_action_extra("display:dataWritten", end_buffer);
    EPD_7IN3E_TurnOnDisplay();
}

/******************************************************************************
function :  Enter sleep mode
parameter:
******************************************************************************/
void EPD_7IN3E_Sleep(void)
{
    log_debug_action("sleep:start");
    EPD_7IN3E_SendCommand(0X02); // DEEP_SLEEP
    EPD_7IN3E_SendData(0x00);
    EPD_7IN3E_ReadBusyH();

    EPD_7IN3E_SendCommand(0x07); // DEEP_SLEEP
    EPD_7IN3E_SendData(0XA5);
    log_debug_action("sleep:done");
}

