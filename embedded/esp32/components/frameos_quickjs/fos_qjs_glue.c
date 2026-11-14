// QuickJS runtime factory for FrameOS embedded.
//
// JS heaps are many small allocations — with CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL
// they would all land in scarce internal SRAM. These allocators send every
// QuickJS allocation to PSRAM explicitly (MALLOC_CAP_SPIRAM), falling back to
// any 8-bit-capable heap on PSRAM-less boards. Accounting mirrors quickjs.c's
// js_def_malloc so the malloc limit keeps working, and each runtime's account
// holds the same byte count (burrito.nim's heapBytes reads it).

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

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

/* The runtime's account (fos_qjs_glue.h), handed in as the malloc state's
 * opaque by fos_js_new_runtime_accounted. Its budget is the scene-wide
 * ceiling shared by every runtime of one scene (its context plus one per JS
 * app node): the per-runtime malloc_limit still applies; this stops N
 * runtimes from claiming N × that limit of PSRAM. */
static inline fos_js_runtime_account_t *fos_js_account(JSMallocState *s)
{
    return (fos_js_runtime_account_t *)s->opaque;
}

static inline fos_js_heap_budget_t *fos_js_budget(JSMallocState *s)
{
    fos_js_runtime_account_t *a = fos_js_account(s);
    return a != NULL ? a->budget : NULL;
}

static inline bool fos_js_budget_allows(fos_js_heap_budget_t *b, size_t extra)
{
    return b == NULL || b->limit_bytes == 0 || b->used_bytes + extra <= b->limit_bytes;
}

static inline void fos_js_charge(JSMallocState *s, size_t bytes)
{
    fos_js_runtime_account_t *a = fos_js_account(s);
    s->malloc_size += bytes;
    if (a == NULL) return;
    a->bytes += bytes;
    if (a->budget != NULL) a->budget->used_bytes += bytes;
}

static inline void fos_js_release(JSMallocState *s, size_t bytes)
{
    fos_js_runtime_account_t *a = fos_js_account(s);
    s->malloc_size -= bytes;
    if (a == NULL) return;
    a->bytes -= bytes; /* in step with malloc_size, which the same calls built */
    fos_js_heap_budget_t *b = a->budget;
    if (b != NULL) b->used_bytes = b->used_bytes > bytes ? b->used_bytes - bytes : 0;
}

static void *fos_js_malloc(JSMallocState *s, size_t size)
{
    void *ptr;

    assert(size != 0);
    if (s->malloc_size + size > s->malloc_limit)
        return NULL;
    if (!fos_js_budget_allows(fos_js_budget(s), size))
        return NULL;
    ptr = fos_js_alloc(size);
    if (ptr == NULL)
        return NULL;
    s->malloc_count++;
    fos_js_charge(s, fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD);
    return ptr;
}

static void fos_js_free(JSMallocState *s, void *ptr)
{
    if (ptr == NULL)
        return;
    s->malloc_count--;
    fos_js_release(s, fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD);
    heap_caps_free(ptr);
}

bool fos_heap_realloc_outside_lock = false;

void *fos_heap_realloc(void *ptr, size_t size, uint32_t caps)
{
    if (!fos_heap_realloc_outside_lock || ptr == NULL || size < FOS_HEAP_REALLOC_UNLOCKED_MIN) {
        return heap_caps_realloc(ptr, size, caps);
    }
    size_t old_size = heap_caps_get_allocated_size(ptr);
    if (old_size == 0 || size <= old_size) return heap_caps_realloc(ptr, size, caps); /* shrinks never copy */
    void *next = heap_caps_malloc(size, caps);
    if (next == NULL) return NULL; /* the old block is untouched, as with realloc */
    memcpy(next, ptr, old_size);
    heap_caps_free(ptr);
    return next;
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
    if (size > old_size && !fos_js_budget_allows(fos_js_budget(s), size - old_size))
        return NULL;

    // No heap_caps_realloc with caps fallback chain: realloc keeps the
    // original heap, which is what we want (stays in PSRAM).
    new_ptr = fos_heap_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (new_ptr == NULL)
        new_ptr = fos_heap_realloc(ptr, size, MALLOC_CAP_8BIT);
    if (new_ptr == NULL)
        return NULL;
    size_t new_size = fos_js_usable_size(new_ptr);
    if (new_size >= old_size)
        fos_js_charge(s, new_size - old_size);
    else
        fos_js_release(s, old_size - new_size);
    return new_ptr;
}

static const JSMallocFunctions fos_js_malloc_funcs = {
    .js_malloc = fos_js_malloc,
    .js_free = fos_js_free,
    .js_realloc = fos_js_realloc,
    .js_malloc_usable_size = fos_js_usable_size,
};

struct JSRuntime *fos_js_new_runtime_accounted(fos_js_runtime_account_t *account)
{
    JSRuntime *rt = JS_NewRuntime2(&fos_js_malloc_funcs, account);
    if (rt == NULL)
        return NULL;
    JS_SetMemoryLimit(rt, FOS_JS_MEMORY_LIMIT);
    JS_SetMaxStackSize(rt, FOS_JS_STACK_SIZE);
    return rt;
}

struct JSRuntime *fos_js_new_runtime(void)
{
    return fos_js_new_runtime_accounted(NULL);
}
