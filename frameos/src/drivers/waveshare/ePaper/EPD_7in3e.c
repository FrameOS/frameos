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

/* FrameOS divergence: the driver narrates what it does. Events go through the
 * DEV_Config debug hook (DEV_Config.h): a JSON driver event on FrameOS/Linux,
 * the console at debug level on ESP32, and nothing at all when unset. */
static void log_debug_action_extra(const char *action, const char *extra)
{
    DEV_Debug_Log(action, extra);
}

static void log_debug_action(const char *action)
{
    DEV_Debug_Log(action, NULL);
}

/* FrameOS divergence from the Waveshare driver:
 * PhotoPainter uses the same 7.3e controller command set, but its board-level
 * power sequencing is handled by the ESP32-S3 PhotoPainter PMIC integration.
 * Keep this as a runtime switch so the normal 7.3e path can stay close to
 * upstream while PhotoPainter skips the panel command that leaves it blank.
 */
static int photo_painter_mode = 0;

/* FrameOS divergence:
 * Upstream waits indefinitely for BUSY to return HIGH. On embedded FrameOS this
 * can wedge the render loop permanently if the board/panel misses the BUSY
 * transition, so cap the wait and log the timeout explicitly.
 */

void EPD_7IN3E_SetPhotoPainterMode(int enabled)
{
    photo_painter_mode = enabled ? 1 : 0;
}


/******************************************************************************
function :  Software reset
parameter:
******************************************************************************/
static void EPD_7IN3E_Reset(void)
{
    log_debug_action("reset:start");

    /* FrameOS divergence:
     * Waveshare's sample reset pulse is very short. The PhotoPainter board was
     * observed to need a more conservative high/low/high sequence after PMIC
     * power-up. The longer pulse is harmless for the normal 7.3e panel path and
     * avoids a separate duplicate reset implementation.
     */
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(50);
    DEV_Digital_Write(EPD_RST_PIN, 0);
    DEV_Delay_ms(20);
    DEV_Digital_Write(EPD_RST_PIN, 1);
    DEV_Delay_ms(50);
    log_debug_action("reset:done");
}

/******************************************************************************
function :  send command
parameter:
     Reg : Command register
******************************************************************************/
static void EPD_7IN3E_SendCommand(UBYTE Reg)
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
static void EPD_7IN3E_SendData(UBYTE Data)
{
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_WriteByte(Data);
    DEV_Digital_Write(EPD_CS_PIN, 1);

    DEV_Debug_Data(Data);
}

static void EPD_7IN3E_SendDataBuffer(UBYTE *Data, uint32_t Len)
{
    if (Data == NULL || Len == 0) {
        return;
    }

    /* FrameOS divergence:
     * Upstream writes the framebuffer byte-by-byte through EPD_7IN3E_SendData.
     * ESP32 SPI can transfer the whole 192 KB 7.3e framebuffer in one CS window,
     * which keeps refresh latency reasonable while preserving the command flow.
     */
    DEV_Digital_Write(EPD_DC_PIN, 1);
    DEV_Digital_Write(EPD_CS_PIN, 0);
    DEV_SPI_Write_nByte(Data, Len);
    DEV_Digital_Write(EPD_CS_PIN, 1);

    DEV_Debug_DataBulk(Data, Len);
}

/******************************************************************************
function :  Wait until the busy_pin goes LOW
parameter:
******************************************************************************/
static int EPD_7IN3E_ReadBusyH(const char *stage)
{
    /* FrameOS divergence:
     * Return whether the BUSY line was actually observed LOW before going idle.
     * The caller uses this to detect panels/boards that acknowledge the command
     * too quickly for the sampled BUSY line and need a fixed refresh delay.
     * -1 on timeout (reported through DEV_Error). */
    return DEV_Busy_Wait(stage, 0, 1);
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
    EPD_7IN3E_ReadBusyH("turnOnDisplay:powerOn");

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

    /* FrameOS divergence:
     * The PhotoPainter path can miss the LOW BUSY pulse after DISPLAY_REFRESH.
     * When that happens, upstream would continue immediately and power off while
     * the panel is still refreshing. Give the controller a short settle window,
     * then fall back to the measured full-refresh duration if BUSY never went
     * LOW.
     */
    DEV_Delay_ms(100);
    int refresh_busy_observed = EPD_7IN3E_ReadBusyH("turnOnDisplay:refresh");
    if (refresh_busy_observed == 0) {
        log_debug_action_extra("turnOnDisplay:refreshFixedWait", "\"durationMs\":25000");
        DEV_Delay_ms(25000);
    }

    log_debug_action("turnOnDisplay:powerOff");
    EPD_7IN3E_SendCommand(0x02); // POWER_OFF
    EPD_7IN3E_SendData(0X00);
    EPD_7IN3E_ReadBusyH("turnOnDisplay:powerOff");

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
    EPD_7IN3E_ReadBusyH("init:reset");
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
    EPD_7IN3E_ReadBusyH("init:powerOn");          //waiting for the electronic paper IC to release the idle signal

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
             "\"color\":%u,\"widthBytes\":%u,\"height\":%u,\"totalBytes\":%lu",
             (unsigned int)color, Width, Height, total_bytes);
    log_debug_action_extra("clear:start", start_buffer);

    EPD_7IN3E_SendCommand(0x10);
    for (UWORD j = 0; j < Height; j++) {
        for (UWORD i = 0; i < Width; i++) {
            EPD_7IN3E_SendData((color<<4)|color);
        }
    }

    char end_buffer[128];
    snprintf(end_buffer, sizeof(end_buffer), "\"totalBytes\":%lu", total_bytes);
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

    log_debug_action_extra("show7Block:start", "\"blocks\":6,\"bytesPerBlock\":20000");

    EPD_7IN3E_SendCommand(0x10);
    for(k = 0 ; k < 6; k ++) {
        for(j = 0 ; j < 20000; j ++) {
            EPD_7IN3E_SendData((Color_seven[k]<<4) |Color_seven[k]);
        }
    }
    log_debug_action_extra("show7Block:dataWritten", "\"totalBytes\":120000");
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
             "\"widthBytes\":%u,\"height\":%u,\"totalBytes\":%lu", Width, Height, total_bytes);
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
    snprintf(data_buffer, sizeof(data_buffer), "\"totalBytes\":%lu", total_bytes);
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
             "\"widthBytes\":%u,\"height\":%u,\"totalBytes\":%lu", Width, Height, total_bytes);
    log_debug_action_extra("display:start", start_buffer);

    DEV_Debug_Preview(Image, total_bytes);

    EPD_7IN3E_SendCommand(0x10);

    /* FrameOS divergence:
     * See EPD_7IN3E_SendDataBuffer above. This replaces only the framebuffer
     * write loop; the surrounding 0x10/write/refresh sequence remains upstream.
     */
    EPD_7IN3E_SendDataBuffer(Image, (uint32_t)total_bytes);
    char end_buffer[128];
    snprintf(end_buffer, sizeof(end_buffer), "\"totalBytes\":%lu", total_bytes);
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

    /* FrameOS divergence:
     * On PhotoPainter, sending the final 0x07/0xA5 deep-sleep sequence after
     * POWER_OFF leaves the display white/blank on the next refresh. The normal
     * 7.3e path keeps the Waveshare deep-sleep sequence below.
     */
    if (photo_painter_mode) {
        log_debug_action_extra("sleep:skipDeepSleep",
                               "\"reason\":\"turnOnDisplay already powers off the PhotoPainter panel\"");
        log_debug_action("sleep:done");
        return;
    }

    EPD_7IN3E_SendCommand(0X02); // DEEP_SLEEP
    EPD_7IN3E_SendData(0x00);
    EPD_7IN3E_ReadBusyH("sleep:powerOff");

    EPD_7IN3E_SendCommand(0x07); // DEEP_SLEEP
    EPD_7IN3E_SendData(0XA5);
    log_debug_action("sleep:done");
}
