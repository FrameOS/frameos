#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "fos_config.h"

esp_err_t fos_assets_sd_mount(const fos_config_t *config);
bool fos_assets_sd_mounted(void);
uint64_t fos_assets_sd_capacity_bytes(void);

