/*
 * Host stand-in for FreeRTOS.h, for the laptop build of fos_events.c — the
 * only thing it wants from the kernel is a short-lived task for a deferred
 * restart. Only what that file uses; the test supplies the functions.
 */
#pragma once

#include <stdint.h>

typedef int BaseType_t;
typedef unsigned int UBaseType_t;
typedef uint32_t TickType_t;

#define pdPASS 1
#define pdFAIL 0
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))

/* The deferred-event queue (fos_events.c) guards its slots with a spinlock
 * on the chip; the host test is single-threaded. */
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(mux) ((void)(mux))
#define portEXIT_CRITICAL(mux) ((void)(mux))
