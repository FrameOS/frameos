/*
 * ESP-IDF implementation of the Waveshare DEV_Config hardware interface.
 *
 * Same API surface as frameos/src/drivers/waveshare/ePaper/DEV_Config.h (the
 * Raspberry Pi / lgpio version), so the vendor EPD_*.c panel drivers compile
 * unmodified. Pins are runtime-configurable via DEV_SetPinConfig — the GPIO
 * remap layer for embedded boards.
 */
#ifndef _DEV_CONFIG_H_
#define _DEV_CONFIG_H_

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "Debug.h"

#define UBYTE   uint8_t
#define UWORD   uint16_t
#define UDOUBLE uint32_t

extern int EPD_RST_PIN;
extern int EPD_DC_PIN;
extern int EPD_CS_PIN;
extern int EPD_CS_M_PIN;
extern int EPD_CS_S_PIN;
extern int EPD_BUSY_PIN;
extern int EPD_PWR_PIN;
extern int EPD_MOSI_PIN;
extern int EPD_SCLK_PIN;

/* Upper bound for busy-pin waits (see vendor EPD_WaitUntilIdle loops). */
#define EPD_BUSY_TIMEOUT_MS 120000

/* GPIO remap: call before DEV_Module_Init. -1 leaves a pin unchanged
 * (pwr may be -1 permanently = not wired). */
void DEV_SetPinConfig(int rst, int dc, int cs, int cs2, int busy, int sclk, int mosi, int pwr);

void DEV_Digital_Write(UWORD Pin, UBYTE Value);
UBYTE DEV_Digital_Read(UWORD Pin);

void DEV_SPI_WriteByte(UBYTE Value);
void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len);
void DEV_Delay_ms(UDOUBLE xms);
UDOUBLE DEV_Millis(void);

void DEV_SPI_SendData(UBYTE Reg);
void DEV_SPI_SendnData(UBYTE *Reg);
UBYTE DEV_SPI_ReadData();

UBYTE DEV_Module_Init(void);
void DEV_Module_Exit(void);

/*
 * Structured debug logging for the panel drivers; same contract as the
 * Raspberry Pi DEV_Config.h (frameos/src/drivers/waveshare/ePaper). On
 * ESP-IDF the events go to the console at debug level.
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
