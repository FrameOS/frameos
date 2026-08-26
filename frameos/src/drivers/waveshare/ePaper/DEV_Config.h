/*****************************************************************************
* | File      	:   DEV_Config.h
* | Author      :   Waveshare team
* | Function    :   Hardware underlying interface
* | Info        :
*                Used to shield the underlying layers of each master
*                and enhance portability
*----------------
* |	This version:   V2.0
* | Date        :   2018-10-30
* | Info        :
* 1.add:
*   UBYTE\UWORD\UDOUBLE
* 2.Change:
*   EPD_RST -> EPD_RST_PIN
*   EPD_DC -> EPD_DC_PIN
*   EPD_CS -> EPD_CS_PIN
*   EPD_BUSY -> EPD_BUSY_PIN
* 3.Remote:
*   EPD_RST_1\EPD_RST_0
*   EPD_DC_1\EPD_DC_0
*   EPD_CS_1\EPD_CS_0
*   EPD_BUSY_1\EPD_BUSY_0
* 3.add:
*   #define DEV_Digital_Write(_pin, _value) bcm2835_GPIOI_write(_pin, _value)
*   #define DEV_Digital_Read(_pin) bcm2835_GPIOI_lev(_pin)
*   #define DEV_SPI_WriteByte(__value) bcm2835_spi_transfer(__value)
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
#ifndef _DEV_CONFIG_H_
#define _DEV_CONFIG_H_

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include "Debug.h"

#include "lgpio.h"
#define LFLAGS 0
#define NUM_MAXBUF  4

#define UBYTE   uint8_t
#define UWORD   uint16_t
#define UDOUBLE uint32_t

/*
 * FrameOS divergence from the Waveshare tree: pins are runtime variables
 * (remapped through DEV_SetPinConfig) and the HAL knows about a second chip
 * select for dual-controller panels (EPD_13in3e). This header is the contract
 * every EPD_*.c driver is written against; the ESP32 firmware ships its own
 * DEV_Config.h with the same declarations
 * (embedded/esp32/components/frameos_display/include/DEV_Config.h) — keep
 * the two in step.
 */
extern int EPD_RST_PIN;
extern int EPD_DC_PIN;
extern int EPD_CS_PIN;
extern int EPD_CS_M_PIN;   /* master controller CS; same pin as EPD_CS_PIN */
extern int EPD_CS_S_PIN;   /* slave controller CS, -1 on single-controller panels */
extern int EPD_BUSY_PIN;
extern int EPD_PWR_PIN;
extern int EPD_MOSI_PIN;
extern int EPD_SCLK_PIN;

/* -1 keeps the driver's default for that pin (cs2 and pwr: -1 = not wired). */
void DEV_SetPinConfig(int rst, int dc, int cs, int cs2, int busy, int sclk, int mosi, int pwr);

void DEV_Digital_Write(UWORD Pin, UBYTE Value);
UBYTE DEV_Digital_Read(UWORD Pin);

void DEV_SPI_WriteByte(UBYTE Value);
void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len);
void DEV_Delay_ms(UDOUBLE xms);
/* Monotonic milliseconds, for busy-wait accounting. */
UDOUBLE DEV_Millis(void);

// Upper bound for busy-pin waits. A full e-paper refresh takes ~30s;
// anything past this means a wedged controller, and spinning forever
// hangs the caller's render thread.
#define EPD_BUSY_TIMEOUT_MS 120000

void DEV_SPI_SendData(UBYTE Reg);
void DEV_SPI_SendnData(UBYTE *Reg);
UBYTE DEV_SPI_ReadData();

UBYTE DEV_Module_Init(void);
void DEV_Module_Exit(void);

/*
 * Structured debug logging for the panel drivers. `action` names the step
 * ("busy:wait:start", "init:done", ...); `extraJson` is an optional list of
 * JSON members without the surrounding braces ("\"stage\":\"refresh\",
 * \"elapsedMs\":12"), or NULL. The host decides where it goes: FrameOS on
 * Linux forwards it to the frame's driver debug log as one JSON event, the
 * ESP32 firmware prints it at debug level. Drivers should check
 * DEV_Debug_Enabled() before formatting anything expensive.
 */
typedef void (*DEV_DebugLogFn)(const char *action, const char *extraJson);
void DEV_SetDebugLog(DEV_DebugLogFn fn);
int DEV_Debug_Enabled(void);
void DEV_Debug_Log(const char *action, const char *extraJson);

/*
 * Errors a driver cannot recover from (busy timeouts). Always printed; on
 * FrameOS/Linux the message is also kept so the Nim side can turn the render
 * into a failed one (DEV_TakeError), on ESP32 it goes to the error log.
 */
void DEV_Error(const char *fmt, ...);
int DEV_TakeError(char *buf, size_t len);

/* Shared diagnostics implemented in DEV_Debug.c (built on the target's
 * DEV_Config). Drivers call these from SendCommand/SendData and around
 * framebuffer transfers so every panel narrates the same way. */
void DEV_Debug_PinStates(char *buf, size_t len);
void DEV_Debug_LogBytes(const char *action, unsigned long totalBytes);
void DEV_Debug_Command(UBYTE reg);
void DEV_Debug_Data(UBYTE data);
void DEV_Debug_DataBulk(const UBYTE *data, uint32_t len);
void DEV_Debug_Preview(const UBYTE *image, unsigned long totalBytes);
/* Poll BUSY until it leaves `busy_level`. Returns 1 if the panel was seen
 * busy and released, 0 if it was never busy, -1 on EPD_BUSY_TIMEOUT_MS
 * (already reported through DEV_Error). Logs start/progress/end events. */
int DEV_Busy_Wait(const char *stage, int busy_level, UDOUBLE poll_ms);


#endif
