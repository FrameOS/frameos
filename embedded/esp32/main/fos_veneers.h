/*
 * Calls from the firmware's C to ROM and IRAM, made short.
 *
 * Every call ESP-IDF compiles is an L32R of the target's address and a
 * CALLX8 through it (-mlongcalls), six bytes and a four-byte literal, which
 * the linker shrinks to a three-byte CALL8 when the target is within 512 KB.
 * libc's string functions are in ROM (0x4000_0000) and esp_log, malloc/free,
 * esp_timer and FreeRTOS in IRAM (0x4037_0000): 32 MB from the flash this
 * code runs in, so every one of the shell's ~2,900 calls to them stayed long.
 *
 * This header is forced into the firmware's C (-include, main/CMakeLists.txt)
 * and sends those calls to a veneer of each function instead: six bytes of
 * code and a literal in flash (fos_printf.c), `l32r a9, <target>; jx a9`,
 * within reach of every caller. The calls' own literals were mostly shared
 * with other pools already, so a call saves its three bytes (−5.9 KB over
 * the shell, 2026-11-24). A CALL8 leaves the caller's a9 free until
 * the callee's ENTRY (it becomes the callee's stack pointer there), and JX
 * leaves PS.CALLINC as the CALL8 set it, so the callee runs exactly as if it
 * had been called directly: same arguments, same return, no frame of its own
 * in a backtrace. The ROM and IRAM functions themselves do not change.
 *
 * A veneer is flash code. Code that can run while the flash cache is off (an
 * IRAM_ATTR interrupt handler) must not call one: a file with IRAM code is
 * left out of the -include (main/CMakeLists.txt), and test_esp32_veneers.py
 * holds every C file in main that says IRAM_ATTR to that list.
 *
 * The C library's functions keep their names to the compiler (an asm label,
 * not a macro), so GCC still folds strlen("...") and the like; the rest are
 * renamed by a macro before ESP-IDF's headers declare them. The memset and
 * memcpy GCC writes itself (a `= {0}`, a struct copy) stay direct calls:
 * ESP-IDF builds with -fno-builtin-memset/-memcpy, which leaves the
 * compiler's own block operations out of the asm label's reach.
 * A function listed here and not in FOS_VENEERS (or the other way) is a link
 * error, not a silent long call. Xtensa only: the C3 is RISC-V.
 */
#pragma once

#if defined(__XTENSA__)

/* (return type, name, parameters): C library functions GCC knows as builtins
 * or that newlib declares; the declarations match newlib's. */
#define FOS_VENEER_LIBC(X)                                                    \
    X(int, strcmp, (const char *, const char *))                              \
    X(int, strncmp, (const char *, const char *, __SIZE_TYPE__))              \
    X(int, strcasecmp, (const char *, const char *))                          \
    X(int, strncasecmp, (const char *, const char *, __SIZE_TYPE__))          \
    X(__SIZE_TYPE__, strlen, (const char *))                                  \
    X(__SIZE_TYPE__, strlcpy, (char *, const char *, __SIZE_TYPE__))          \
    X(__SIZE_TYPE__, strlcat, (char *, const char *, __SIZE_TYPE__))          \
    X(char *, strcpy, (char *, const char *))                                 \
    X(char *, strchr, (const char *, int))                                    \
    X(char *, strstr, (const char *, const char *))                           \
    X(char *, strtok_r, (char *, const char *, char **))                      \
    X(void *, memset, (void *, int, __SIZE_TYPE__))                           \
    X(void *, memcpy, (void *, const void *, __SIZE_TYPE__))                  \
    X(void *, memmove, (void *, const void *, __SIZE_TYPE__))                 \
    X(int, memcmp, (const void *, const void *, __SIZE_TYPE__))               \
    X(int, atoi, (const char *))                                              \
    X(long, strtol, (const char *, char **, int))                             \
    X(unsigned long, strtoul, (const char *, char **, int))                   \
    X(void *, malloc, (__SIZE_TYPE__))                                        \
    X(void *, calloc, (__SIZE_TYPE__, __SIZE_TYPE__))                         \
    X(void, free, (void *))

/* ESP-IDF's, renamed below before its headers declare them. */
#define FOS_VENEER_IDF(X)                                                     \
    X(esp_log)                                                                \
    X(esp_timer_get_time)                                                     \
    X(esp_timer_stop)                                                         \
    X(esp_timer_start_once)                                                   \
    X(heap_caps_malloc)                                                       \
    X(heap_caps_calloc)                                                       \
    X(vTaskDelay)                                                             \
    X(vTaskDelete)                                                            \
    X(xTaskCreatePinnedToCore)                                                \
    X(xTaskGetTickCount)                                                      \
    X(xTaskGetCurrentTaskHandle)                                              \
    X(xTaskGenericNotify)                                                     \
    X(vPortExitCritical)                                                      \
    X(xPortEnterCriticalTimeout)                                              \
    X(xQueueGenericSend)                                                      \
    X(xQueueSemaphoreTake)                                                    \
    X(xQueueReceive)                                                          \
    X(xQueueCreateMutex)                                                      \
    X(xQueueGenericCreate)                                                    \
    X(vQueueDelete)                                                           \
    X(xEventGroupSetBits)                                                     \
    X(xEventGroupClearBits)

#ifndef __ASSEMBLER__
#define FOS_VENEER_DECLARE(ret, name, params) ret name params __asm__("fos_v_" #name);
FOS_VENEER_LIBC(FOS_VENEER_DECLARE)
#undef FOS_VENEER_DECLARE

#define esp_log fos_v_esp_log
#define esp_timer_get_time fos_v_esp_timer_get_time
#define esp_timer_stop fos_v_esp_timer_stop
#define esp_timer_start_once fos_v_esp_timer_start_once
#define heap_caps_malloc fos_v_heap_caps_malloc
#define heap_caps_calloc fos_v_heap_caps_calloc
#define vTaskDelay fos_v_vTaskDelay
#define vTaskDelete fos_v_vTaskDelete
#define xTaskCreatePinnedToCore fos_v_xTaskCreatePinnedToCore
#define xTaskGetTickCount fos_v_xTaskGetTickCount
#define xTaskGetCurrentTaskHandle fos_v_xTaskGetCurrentTaskHandle
#define xTaskGenericNotify fos_v_xTaskGenericNotify
#define vPortExitCritical fos_v_vPortExitCritical
#define xPortEnterCriticalTimeout fos_v_xPortEnterCriticalTimeout
#define xQueueGenericSend fos_v_xQueueGenericSend
#define xQueueSemaphoreTake fos_v_xQueueSemaphoreTake
#define xQueueReceive fos_v_xQueueReceive
#define xQueueCreateMutex fos_v_xQueueCreateMutex
#define xQueueGenericCreate fos_v_xQueueGenericCreate
#define vQueueDelete fos_v_vQueueDelete
#define xEventGroupSetBits fos_v_xEventGroupSetBits
#define xEventGroupClearBits fos_v_xEventGroupClearBits
#endif /* __ASSEMBLER__ */

#endif /* __XTENSA__ */
