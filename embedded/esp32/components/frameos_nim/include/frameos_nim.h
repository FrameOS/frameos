/*
 * C surface of the FrameOS Nim runtime (M2: Nim core on the metal).
 *
 * The real implementation is Nim code from frameos/src/embedded compiled to C
 * (see build_nim.sh) and dropped into this component's nimcache/ directory.
 * When no nimcache is present the stub implementation reports "unavailable"
 * and the firmware falls back to thin-client mode.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* True when the Nim runtime is compiled in. */
bool frameos_nim_available(void);
/* One-time init: panel dimensions + frame name. Safe to call when
 * unavailable (returns false). Allocates the Nim heap (PSRAM via malloc). */
bool frameos_nim_init(int width, int height, const char *frame_name);
/* Render the current scene into `buf` as packed 1bpp (white=1, MSB first).
 * Returns 0 on success. */
int frameos_nim_render_1bpp(uint8_t *buf, size_t len);
/* Free-form info string (Nim/runtime versions, render counter). */
const char *frameos_nim_info(void);

/* Provided by the firmware for the Nim side (logging hook). */
void frameos_nim_log_hook(const char *msg);

#ifdef __cplusplus
}
#endif
