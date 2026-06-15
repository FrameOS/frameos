// QuickJS runtime factory for FrameOS embedded.
//
// JS heaps are many small allocations — with CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL
// they would all land in scarce internal SRAM. These allocators send every
// QuickJS allocation to PSRAM explicitly (MALLOC_CAP_SPIRAM), falling back to
// any 8-bit-capable heap on PSRAM-less boards. Accounting mirrors quickjs.c's
// js_def_malloc so JS_ComputeMemoryUsage and the malloc limit keep working.

#include <assert.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_heap_caps.h"
#include "quickjs/quickjs.h"
#include "fos_qjs_glue.h"

// Matches MALLOC_OVERHEAD in quickjs.c (not exported by the header).
#define FOS_JS_MALLOC_OVERHEAD 8

// 4MB JS heap cap: roomy for scene graphs + JSON, and keeps a runaway scene
// from starving pixie's framebuffers (8MB PSRAM total on the XIAO ESP32-S3).
#define FOS_JS_MEMORY_LIMIT (4 * 1024 * 1024)

// The render task stack is 48KB (fos_client.c); leave headroom for the Nim
// and pixie frames beneath the interpreter.
#define FOS_JS_STACK_SIZE (20 * 1024)

static void *fos_js_alloc(size_t size)
{
    void *ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr == NULL)
        ptr = heap_caps_malloc(size, MALLOC_CAP_8BIT);
    return ptr;
}

static size_t fos_js_usable_size(const void *ptr)
{
    if (ptr == NULL)
        return 0;
    return heap_caps_get_allocated_size((void *)ptr);
}

static void *fos_js_malloc(JSMallocState *s, size_t size)
{
    void *ptr;

    assert(size != 0);
    if (s->malloc_size + size > s->malloc_limit)
        return NULL;
    ptr = fos_js_alloc(size);
    if (ptr == NULL)
        return NULL;
    s->malloc_count++;
    s->malloc_size += fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD;
    return ptr;
}

static void fos_js_free(JSMallocState *s, void *ptr)
{
    if (ptr == NULL)
        return;
    s->malloc_count--;
    s->malloc_size -= fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD;
    heap_caps_free(ptr);
}

static void *fos_js_realloc(JSMallocState *s, void *ptr, size_t size)
{
    size_t old_size;
    void *new_ptr;

    if (ptr == NULL) {
        if (size == 0)
            return NULL;
        return fos_js_malloc(s, size);
    }
    old_size = fos_js_usable_size(ptr);
    if (size == 0) {
        fos_js_free(s, ptr);
        return NULL;
    }
    if (s->malloc_size + size - old_size > s->malloc_limit)
        return NULL;

    // No heap_caps_realloc with caps fallback chain: realloc keeps the
    // original heap, which is what we want (stays in PSRAM).
    new_ptr = heap_caps_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (new_ptr == NULL)
        new_ptr = heap_caps_realloc(ptr, size, MALLOC_CAP_8BIT);
    if (new_ptr == NULL)
        return NULL;
    s->malloc_size += fos_js_usable_size(new_ptr) - old_size;
    return new_ptr;
}

static const JSMallocFunctions fos_js_malloc_funcs = {
    .js_malloc = fos_js_malloc,
    .js_free = fos_js_free,
    .js_realloc = fos_js_realloc,
    .js_malloc_usable_size = fos_js_usable_size,
};

struct JSRuntime *fos_js_new_runtime(void)
{
    JSRuntime *rt = JS_NewRuntime2(&fos_js_malloc_funcs, NULL);
    if (rt == NULL)
        return NULL;
    JS_SetMemoryLimit(rt, FOS_JS_MEMORY_LIMIT);
    JS_SetMaxStackSize(rt, FOS_JS_STACK_SIZE);
    return rt;
}
