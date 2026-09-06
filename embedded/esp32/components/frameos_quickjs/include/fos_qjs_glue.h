// QuickJS runtime factory for FrameOS embedded: PSRAM heap + bounded stack.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

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

#ifdef __cplusplus
}
#endif
