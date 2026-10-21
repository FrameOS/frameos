// Where the firmware keeps things in flash. There is no partition table on a
// Pico: the UF2 owns the front of the chip and the firmware keeps two 4 KB
// sectors near the end. PICO_FLASH_SIZE_BYTES comes from the board definition
// (2 MB pico_w, 4 MB pico2_w), so the offsets follow the target. A UF2 only
// writes the blocks it carries, which is why both sectors survive a firmware
// update — and why there is no OTA: nothing here could hold a second image.
//
// Except the last sector. Every RP2350 UF2 the SDK builds starts with a block
// for the very end of the flash window (picotool `--abs-block`, the
// RP2350-E10 erratum workaround), and on a 4 MB chip that lands on the last
// sector's last page: the bootrom erases the sector to write it. Until
// 2026-10-21 that was the config, and every update of a Pico 2 W forgot its
// Wi-Fi and backend. Nothing lives there now.
#ifndef PK_FLASH_LAYOUT_H
#define PK_FLASH_LAYOUT_H

#include "hardware/flash.h"

// Render state (pk_state.c): an append log, erased once per 128 renders.
#define PK_FLASH_STATE_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
// Configuration (pk_config.c): rewritten only when a setting changes.
#define PK_FLASH_CONFIG_OFFSET (PICO_FLASH_SIZE_BYTES - 3 * FLASH_SECTOR_SIZE)
// Where the config lived until then: read once, so a Pico W (no E10 block in
// its UF2) keeps its settings through the update that moved them.
#define PK_FLASH_LEGACY_CONFIG_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)

#endif // PK_FLASH_LAYOUT_H
