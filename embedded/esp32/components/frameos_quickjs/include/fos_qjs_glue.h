// QuickJS runtime factory for FrameOS embedded: PSRAM heap + bounded stack.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct JSRuntime;

/* One scene's shared JS heap ceiling, drawn on by every runtime the scene
 * creates. Layout matches JsHeapBudget in frameos/src/frameos/js_runtime/
 * burrito.nim (two size_t: limit, then used); the Nim side owns the memory
 * for the process lifetime. limit_bytes 0 = no shared ceiling. */
typedef struct fos_js_heap_budget {
    size_t limit_bytes;
    size_t used_bytes;
} fos_js_heap_budget_t;

/* fos_js_new_runtime, plus the scene's shared budget (NULL for none). */
struct JSRuntime *fos_js_new_runtime_budgeted(fos_js_heap_budget_t *budget);

// Create a JSRuntime whose allocations go to PSRAM (8-bit capable SPIRAM,
// falling back to internal RAM when PSRAM is absent), with a memory limit
// and an interpreter stack limit sized for the render task. Must be called
// from the task that will run JS: QuickJS records the stack top at creation
// for its overflow check.
struct JSRuntime *fos_js_new_runtime(void);

/* Growing a block the heap must move: the IDF heap's realloc copies the old
 * contents while holding its spinlock, interrupts off on that core for the
 * whole copy — 1-2 ms for the 50-100 KB buffers a render grows. An RGB LCD's
 * scan-out refill cannot wait that long (lcd_st7701s_rgb.c: a band of stale
 * lines for one frame). With this on, a block of at least
 * FOS_HEAP_REALLOC_UNLOCKED_MIN bytes that grows is moved by malloc + copy +
 * free, the copy with interrupts on. It costs the in-place growth TLSF could
 * sometimes do (old and new are both held during the copy), so it is off
 * unless the panel is an LCD (frameos_nim_set_realloc_outside_lock). */
#define FOS_HEAP_REALLOC_UNLOCKED_MIN 4096
extern bool fos_heap_realloc_outside_lock;
/* heap_caps_realloc under that policy. */
void *fos_heap_realloc(void *ptr, size_t size, uint32_t caps);

#ifdef __cplusplus
}
#endif
