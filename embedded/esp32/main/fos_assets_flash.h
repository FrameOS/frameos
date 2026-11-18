#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* Assets on the state partition, for a board with no SD card wired (the
 * SenseCAP Indicator's slot belongs to its RP2040). fos_assets_flash.c. */

/* The frame's internal storage: the state partition's files at this path on
 * every board that has the partition, whether or not a card is in. JS apps
 * reach it as the storage "internal" (frameos_nim_set_storages). */
#define FOS_ASSETS_INTERNAL_PATH "/srv/internal"

/* Mounts the state partition's files at `assets_path` (which fos_scenes_init
 * mounted at /state). Called once a path: the internal storage path on every
 * board, and the assets path as well where no card slot is in use. */
esp_err_t fos_assets_flash_mount(const char *assets_path);
/* Whether the assets path is on the flash (no card slot in use). */
bool fos_assets_flash_active(void);
/* Whether the internal storage is mounted (FOS_ASSETS_INTERNAL_PATH). */
bool fos_assets_internal_active(void);
/* What an asset may still take: the partition's free bytes less the reserve
 * kept for the scene store. -1 when not mounted. */
int64_t fos_assets_flash_free_bytes(void);
/* The same for a path on one of its mounts, and -1 for any other path: the
 * internal storage is mounted beside an SD card on every board, and its few
 * MB are not what the card at the assets path has free. */
int64_t fos_assets_flash_free_bytes_at(const char *path);
