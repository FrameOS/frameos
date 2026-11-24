/*
 * A failed assert calls __assert_func with no arguments, image-wide.
 *
 * Forced into everything the firmware compiles from source, ESP-IDF's
 * components included (-include, the project's CMakeLists.txt). Under
 * CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT, ESP-IDF's assert.h makes a
 * failed `assert(e)` (and FreeRTOS's configASSERT, which is assert)
 * `__assert_func(NULL, 0, NULL, NULL)`: four null arguments set up at each of
 * the image's ~300 sites, for a function that reads none of them. Its silent
 * half (components/newlib/src/assert.c) prints "assert failed: 0x<address of
 * the call>" from its own return address and calls esp_system_abort; the
 * compiled function touches only a0 and a1. Here the same call is made with
 * no arguments, through a second name for the same symbol: the same line,
 * the same address, the same abort, and the IRAM function it always was
 * (an assert may fail with the flash cache off).
 *
 * Only the failure call changes: whether an assert is compiled at all
 * (NDEBUG) is still assert.h's business, read where each file includes it.
 * newlib (which defines __assert_func) and QuickJS (which has its own,
 * components/frameos_quickjs) are compiled with FOS_ASSERT_PLAIN and keep the
 * plain call. The bootloader is a project of its own and is not given this.
 */
#pragma once

#include "sdkconfig.h"

#if CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT && !defined(FOS_ASSERT_PLAIN) && !defined(__ASSEMBLER__)
#ifdef __cplusplus
extern "C" {
#endif
/* newlib's declaration, made before the macro below would rename it. */
void __assert_func(const char *, int, const char *, const char *) __attribute__((__noreturn__));
/* The same function, called with nothing in its argument registers. */
void fos_assert_failed(void) __asm__("__assert_func") __attribute__((__noreturn__));
#ifdef __cplusplus
}
#endif
#define __assert_func(file, line, func, expr) fos_assert_failed()
#endif
