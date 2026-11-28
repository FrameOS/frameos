#pragma once

#include "sdmmc_cmd.h"

/* FatFS's disk driver for the SD card, in place of ESP-IDF's after the
 * mount: the same calls, except that a buffer the SPI DMA cannot reach (all
 * of PSRAM) moves FOS_SD_BOUNCE_SECTORS sectors a command through internal
 * memory, where IDF's sdmmc_read/write_sectors move it one 512-byte sector
 * a command. See fos_sd_diskio.c. */
void fos_sd_diskio_install(sdmmc_card_t *card);
