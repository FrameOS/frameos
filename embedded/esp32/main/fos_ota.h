/*
 * OTA: pull a signed release app image from the frame's control plane, write
 * it to the inactive ota_0/ota_1 slot, verify, reboot. The bootloader's
 * rollback support boots the new image as "pending verify"; main calls
 * fos_ota_mark_boot_valid() once the runtime is up, otherwise the next reset
 * rolls back to the previous slot.
 *
 * One signed path for both control planes (docs/cloud-frames.md "Signed
 * OTA"): the provider — the self-hosted backend or the cloud — serves a
 * device-authed manifest `{platform, version, size, minisig, downloadUrl}`
 * naming the release's bare app image for this board's flash layout
 * (fos_ota_platform). The image streams to the inactive slot with incremental
 * BLAKE2b-512 hashing and its minisign Ed25519 signature is verified against
 * the release public key baked into the firmware (fos_ota_pubkey.h) BEFORE
 * the boot slot switches. Neither control plane holds the signing key; both
 * can only relay what a release carries.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* The release asset family this image was built for — "esp32-s3-generic",
 * "esp32-s3-16mb", "esp32-c3-generic", … — derived from the chip and the
 * flash layout compiled in, so an OTA always fetches the image whose
 * partition table matches the one on the board. */
const char *fos_ota_platform(void);

/* Mark the running image valid (cancels pending rollback). Call once per
 * boot after the system proves healthy. */
void fos_ota_mark_boot_valid(void);
/* Backend-managed frames: GET the backend's OTA manifest, compare it to the
 * running version, download + verify the release image into the inactive
 * slot when it differs, and reboot on success. */
esp_err_t fos_ota_check_and_apply(void);
bool fos_ota_busy(void);
bool fos_ota_boot_request_pending(void);
esp_err_t fos_ota_run_boot_request(void);
/* Background task that checks every interval_hours (backend-managed). */
void fos_ota_start_periodic_task(uint32_t interval_hours);
/* Request an early-boot OTA check and schedule a reboot into it. The delay
 * lets HTTP and USB callers flush their acknowledgement first. */
esp_err_t fos_ota_request_check(void);

/* Let the NEXT manifest fetch install a release older than the running one.
 * Console `ota downgrade`; see the downgrade note in fos_ota.c. */
void fos_ota_allow_downgrade_once(void);

/* Cloud-managed frames: the same signed path against the enrolled cloud's
 * manifest route, in its own one-shot task; a second request while one runs
 * is ignored. Triggered by the notify_update_available verb. */
void fos_ota_request_cloud_update(void);
