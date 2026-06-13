/*
 * The frame loop. Two render modes:
 *  - local: the Nim runtime renders the scene on-device (M2)
 *  - remote: thin client fetches a backend-prerendered bitmap (M1)
 * Either way the bits end up in fos_display_blit(), then we wait out the
 * refresh interval (deep sleep if configured).
 */
#pragma once

#include "esp_err.h"

void fos_client_start(void);
/* Trigger an immediate render from another task (HTTP action, console). */
void fos_client_render_now(void);
/* Stats for /status & console. */
uint32_t fos_client_render_count(void);
int64_t fos_client_last_render_ms(void);
