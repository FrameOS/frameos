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
extern int EPD_BUSY_PIN;
extern int EPD_PWR_PIN;
extern int EPD_MOSI_PIN;
extern int EPD_SCLK_PIN;

/* Upper bound for busy-pin waits (see vendor EPD_WaitUntilIdle loops). */
#define EPD_BUSY_TIMEOUT_MS 120000

/* GPIO remap: call before DEV_Module_Init. -1 leaves a pin unchanged
 * (pwr may be -1 permanently = not wired). */
void DEV_SetPinConfig(int rst, int dc, int cs, int busy, int sclk, int mosi, int pwr);

void DEV_Digital_Write(UWORD Pin, UBYTE Value);
UBYTE DEV_Digital_Read(UWORD Pin);

void DEV_SPI_WriteByte(UBYTE Value);
void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len);
void DEV_Delay_ms(UDOUBLE xms);

void DEV_SPI_SendData(UBYTE Reg);
void DEV_SPI_SendnData(UBYTE *Reg);
UBYTE DEV_SPI_ReadData();

UBYTE DEV_Module_Init(void);
void DEV_Module_Exit(void);

#endif
