#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* Assets on the state partition, for a board with no SD card wired (the
 * SenseCAP Indicator's slot belongs to its RP2040). fos_assets_flash.c. */

/* Mounts the assets directory at `assets_path` over the state partition
 * (which fos_scenes_init mounted at /state). */
esp_err_t fos_assets_flash_mount(const char *assets_path);
bool fos_assets_flash_active(void);
/* What an asset may still take: the partition's free bytes less the reserve
 * kept for the scene store. -1 when not mounted. */
int64_t fos_assets_flash_free_bytes(void);
