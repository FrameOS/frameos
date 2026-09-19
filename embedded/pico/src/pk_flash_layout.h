// Where the firmware keeps things in flash. There is no partition table on a
// Pico: the UF2 owns the front of the chip and the last two 4 KB sectors are
// the firmware's own. PICO_FLASH_SIZE_BYTES comes from the board definition
// (2 MB pico_w, 4 MB pico2_w), so the offsets follow the target. A UF2 only
// writes the blocks it carries, which is why both sectors survive a firmware
// update — and why there is no OTA: nothing here could hold a second image.
#ifndef PK_FLASH_LAYOUT_H
#define PK_FLASH_LAYOUT_H

#include "hardware/flash.h"

// Configuration (pk_config.c): rewritten only when a setting changes.
#define PK_FLASH_CONFIG_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
// Render state (pk_state.c): an append log, erased once per 128 renders.
#define PK_FLASH_STATE_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)

#endif // PK_FLASH_LAYOUT_H
