// QuickJS runtime factory for FrameOS embedded: PSRAM heap + bounded stack.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

struct JSRuntime;

// Create a JSRuntime whose allocations go to PSRAM (8-bit capable SPIRAM,
// falling back to internal RAM when PSRAM is absent), with a memory limit
// and an interpreter stack limit sized for the render task. Must be called
// from the task that will run JS: QuickJS records the stack top at creation
// for its overflow check.
struct JSRuntime *fos_js_new_runtime(void);

#ifdef __cplusplus
}
#endif
