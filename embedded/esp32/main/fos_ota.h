/*
 * OTA: pull a new app image from the backend, write to the inactive
 * ota_0/ota_1 slot, reboot. The bootloader's rollback support boots the new
 * image as "pending verify"; main calls fos_ota_mark_boot_valid() once the
 * runtime is up, otherwise the next reset rolls back to the previous slot.
 */
#pragma once

#include "esp_err.h"

/* Mark the running image valid (cancels pending rollback). Call once per
 * boot after the system proves healthy. */
void fos_ota_mark_boot_valid(void);
/* GET the backend OTA manifest, compare it to the running image, download the
 * app image to the inactive OTA slot when needed, and reboot on success. */
esp_err_t fos_ota_check_and_apply(void);
/* Background task that checks every interval_hours. */
void fos_ota_start_periodic_task(uint32_t interval_hours);
