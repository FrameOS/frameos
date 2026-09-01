/* Simulated device memory for the browser preview.
 *
 * The preview runs the real interpreter, but in a browser it has effectively
 * unlimited memory — so a scene that exhausts an ESP32's PSRAM renders
 * perfectly here and only fails once it reaches hardware. Capping pixie's
 * decode budget is not enough to catch that: the 13.3" Weather scene's
 * out-of-memory was a plain Nim seq allocation in the TypeScript transpiler,
 * nowhere near a decoder.
 *
 * So this puts a ceiling on the Nim heap itself. Every Nim allocation goes
 * through the wrappers below (src/wasm/patched_malloc.nim, wired up by
 * config.nims), they track live bytes, and past the ceiling they refuse the
 * allocation exactly as heap_caps_malloc does on a full device.
 *
 * A refusal must not take the module down with it. Nim cannot raise from a
 * failed allocImpl under --exceptions:goto (raiseOutOfMem falls through to
 * quit), so this mirrors what the firmware does in frameos_nim_glue.c: a
 * setjmp guard around the render entry point, and a longjmp back to it when
 * an allocation cannot be served. The render reports out-of-memory, the
 * module stays alive, and the caller can re-init.
 *
 * Like the device's guard, the longjmp abandons the Nim stack without
 * running destructors, so an aborted render leaks whatever it held. The
 * preview re-initialises the runtime after an out-of-memory result, which is
 * the same "reboot to recover" the frame does.
 */

#include <setjmp.h>
#include <stdlib.h>

#include "fos_wasm_mem.h"

/* emscripten's real malloc_usable_size; the accounting needs the block size
 * the allocator actually handed out, not the requested size. */
extern size_t malloc_usable_size(void *ptr);

static size_t g_limit = 0;    /* 0 = unlimited (the default: a browser) */
static size_t g_live = 0;     /* live bytes handed out by the wrappers */
static size_t g_baseline = 0; /* live bytes when the limit was set */
static size_t g_peak = 0;     /* high-water live bytes since the limit was set */
static size_t g_failed = 0;   /* size of the allocation that could not be served */
static size_t g_reserve = 0;  /* margin availableRenderBytes keeps below the ceiling */

static jmp_buf g_oom_jmp;
static int g_guard_armed = 0;

/* Live bytes counted against the ceiling. The baseline is everything that
 * already existed when the limit was set — the font tables and other module
 * init that a frame keeps in flash, not in its render budget. */
static size_t charged(void)
{
    return g_live > g_baseline ? g_live - g_baseline : 0;
}

static int would_exceed(size_t freed, size_t wanted)
{
    size_t after;
    if (g_limit == 0) return 0;
    after = charged() - (freed > charged() ? charged() : freed) + wanted;
    return after > g_limit;
}

static void note_live(void)
{
    size_t now = charged();
    if (now > g_peak) g_peak = now;
}

void *fos_wasm_malloc(size_t size)
{
    void *ptr;
    if (size == 0) size = 1;
    if (would_exceed(0, size)) { g_failed = size; return NULL; }
    ptr = malloc(size);
    if (ptr == NULL) { g_failed = size; return NULL; }
    g_live += malloc_usable_size(ptr);
    note_live();
    return ptr;
}

void *fos_wasm_calloc(size_t count, size_t size)
{
    void *ptr;
    size_t total;
    if (count == 0 || size == 0) { count = 1; size = 1; }
    total = count * size;
    if (would_exceed(0, total)) { g_failed = total; return NULL; }
    ptr = calloc(count, size);
    if (ptr == NULL) { g_failed = total; return NULL; }
    g_live += malloc_usable_size(ptr);
    note_live();
    return ptr;
}

void *fos_wasm_realloc(void *ptr, size_t size)
{
    size_t old = ptr ? malloc_usable_size(ptr) : 0;
    void *next;
    if (size == 0) size = 1;
    if (would_exceed(old, size)) { g_failed = size; return NULL; }
    next = realloc(ptr, size);
    /* A failed realloc leaves the original block alive and owned. */
    if (next == NULL) { g_failed = size; return NULL; }
    g_live -= old;
    g_live += malloc_usable_size(next);
    note_live();
    return next;
}

void fos_wasm_free(void *ptr)
{
    if (ptr == NULL) return;
    size_t size = malloc_usable_size(ptr);
    g_live = g_live > size ? g_live - size : 0;
    free(ptr);
}

void fos_wasm_fatal_oom(size_t size)
{
    g_failed = size;
    if (g_guard_armed) {
        g_guard_armed = 0;
        longjmp(g_oom_jmp, 1);
    }
    /* Unguarded (outside a render): let the caller's NULL handling run. */
}

/* ------------------------------------------------------------------ limits */

void frameos_wasm_set_memory_limit(unsigned int bytes, unsigned int reserve)
{
    g_limit = (size_t)bytes;
    g_reserve = (size_t)reserve;
    g_baseline = g_live;
    g_peak = 0;
    g_failed = 0;
}

/* What the render pipeline is told it may still use: the headroom under the
 * ceiling, minus the margin a device keeps for the buffers that live outside
 * its Nim heap (FOS_RENDER_PSRAM_RESERVE). Allocation still succeeds into the
 * margin — this only steers the decode budgets and the degrade ladder, which
 * is exactly what availableRenderBytes does on the device. */
unsigned int frameos_wasm_memory_render_headroom(void)
{
    size_t used, free_bytes;
    if (g_limit == 0) return 0;
    used = charged();
    free_bytes = g_limit > used ? g_limit - used : 0;
    return (unsigned int)(free_bytes > g_reserve ? free_bytes - g_reserve : 0);
}

unsigned int frameos_wasm_memory_limit(void) { return (unsigned int)g_limit; }
unsigned int frameos_wasm_memory_used(void) { return (unsigned int)charged(); }
unsigned int frameos_wasm_memory_peak(void) { return (unsigned int)g_peak; }
unsigned int frameos_wasm_memory_failed(void) { return (unsigned int)g_failed; }

void frameos_wasm_memory_reset_peak(void)
{
    g_peak = charged();
    g_failed = 0;
}

/* --------------------------------------------------------- guarded render */

/* The Nim render entry point, renamed so this wrapper can own the exported
 * `frameos_wasm_render` symbol (src/wasm/wasm_main.nim). */
extern int frameos_wasm_render_impl(void);

int frameos_wasm_render(void)
{
    int rc;
    g_failed = 0;
    if (g_limit == 0) return frameos_wasm_render_impl();

    g_guard_armed = 1;
    if (setjmp(g_oom_jmp) != 0) {
        g_guard_armed = 0;
        return FOS_WASM_RENDER_OOM;
    }
    rc = frameos_wasm_render_impl();
    g_guard_armed = 0;
    return rc;
}
