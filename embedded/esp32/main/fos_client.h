/*
 * The frame loop. Two render modes:
 *  - local: the Nim runtime renders interpreted scenes on-device
 *  - remote: thin client fetches a backend diagnostic bitmap
 * Either way the bits end up in fos_display_blit(), then we wait out the
 * refresh interval (deep sleep if configured).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "frameos_display.h"

void fos_client_start(void);
/* Allow the render loop to run after startup has reserved its stack. */
void fos_client_resume(void);
/* Trigger an immediate render from another task (HTTP action, console). */
/* Repeated-OOM rescue (fos_client.c). A render that exhausts PSRAM and does
 * not get it back leaves a frame that can neither render nor reach the cloud,
 * so it restarts itself; after two consecutive rescues it stops rendering and
 * stays online instead, so a lighter scene can be assigned. */
void fos_client_render_recovery_boot(void);
bool fos_client_render_paused(void);
void fos_client_clear_render_pause(void);
void fos_client_render_now(void);
/* Keep Wi-Fi/HTTP available briefly after a control request on deep-sleep frames. */
void fos_client_keep_awake_ms(uint32_t ms);
/* Stats for /status & console. */
uint32_t fos_client_render_count(void);
int64_t fos_client_last_render_ms(void);
/* Lowest-ever free bytes on the render task's 40 KB internal stack (FreeRTOS
 * high-water mark); 0 before the task starts. */
size_t fos_client_task_stack_free(void);

/* Recent metrics samples (one per render pass); entries oldest-first, each
 * `json` a strdup the caller frees. `timestamp` epoch seconds (pre-SNTP
 * values are seconds-since-boot epochs — filter on > 1e9 for wall time). */
typedef struct {
    double timestamp;
    char *json;
} fos_metrics_sample_t;
size_t fos_client_metrics_recent(fos_metrics_sample_t *out, size_t max);
/* Timestamp of the newest sample (0 when none) — what the cloud client
 * compares against its last push to know whether one is still owed. */
double fos_client_metrics_newest_timestamp(void);
bool fos_client_last_refresh_skipped(void);
const char *fos_client_snapshot_mode(void);
bool fos_client_display_state_ready(void);
/* Last successfully rendered packed framebuffer, for HTTP preview. */
bool fos_client_snapshot_info(int *width, int *height, fos_pixel_format_t *format,
                              size_t *len, uint32_t *render_count, int64_t *render_ms);
esp_err_t fos_client_snapshot_copy(uint8_t *out, size_t out_len, int *width, int *height,
                                   fos_pixel_format_t *format, uint32_t *render_count,
                                   int64_t *render_ms);
/* Borrow the packed snapshot in place for a streaming reader (the cloud
 * image_get, the HTTP preview): on true the snapshot lock is HELD until
 * fos_client_snapshot_release(), and a render that needs the buffer waits
 * for it (bounded) — keep the hold to the seconds it takes to stream. False
 * when there is no snapshot or the lock stayed busy for timeout_ms. */
bool fos_client_snapshot_acquire(uint32_t timeout_ms, const uint8_t **buf, int *width,
                                 int *height, fos_pixel_format_t *format, size_t *len);
void fos_client_snapshot_release(void);
/* True while a render is still owed: this boot's first pass has not finished,
 * or a render signal is queued. An image_get arriving now waits for it
 * instead of answering "no image" seconds before there is one. */
bool fos_client_render_pending(void);
