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
void fos_client_render_now(void);
/* Stats for /status & console. */
uint32_t fos_client_render_count(void);
int64_t fos_client_last_render_ms(void);
/* Last successfully rendered packed framebuffer, for HTTP preview. */
bool fos_client_snapshot_info(int *width, int *height, fos_pixel_format_t *format,
                              size_t *len, uint32_t *render_count, int64_t *render_ms);
esp_err_t fos_client_snapshot_copy(uint8_t *out, size_t out_len, int *width, int *height,
                                   fos_pixel_format_t *format, uint32_t *render_count,
                                   int64_t *render_ms);
