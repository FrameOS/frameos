// QuickJS allocator glue for the wasm build.
//
// QuickJS's own js_def_malloc_usable_size is `return 0;` under
// __EMSCRIPTEN__, which makes the runtime's memory accounting count only
// MALLOC_OVERHEAD per allocation — JS_SetMemoryLimit can then never trip,
// and the preview's device simulation (frameos_wasm_set_device_limits)
// could not enforce the ESP32's 4 MB JS heap. Emscripten's dlmalloc does
// provide a real malloc_usable_size, so this mirrors QuickJS's default
// allocator with that plugged in — the same pattern as the ESP32's
// fos_qjs_glue.c, which sizes allocations via heap_caps.
//
// Compiled into build/wasm/libquickjs.a by tools/build_wasm.sh; the runtime
// is created via fos_js_new_runtime_wasm() (js_runtime/burrito.nim).

#include <assert.h>
#include <malloc.h>
#include <stdlib.h>

#include "quickjs.h"

// QuickJS's MALLOC_OVERHEAD for 32-bit targets (quickjs.c keeps it private).
#define FOS_JS_MALLOC_OVERHEAD 8

static size_t fos_js_usable_size(const void *ptr) {
  return malloc_usable_size((void *)ptr);
}

static void *fos_js_malloc(JSMallocState *s, size_t size) {
  void *ptr;
  assert(size != 0);
  if (s->malloc_size + size > s->malloc_limit)
    return NULL;
  ptr = malloc(size);
  if (!ptr)
    return NULL;
  s->malloc_count++;
  s->malloc_size += fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD;
  return ptr;
}

static void fos_js_free(JSMallocState *s, void *ptr) {
  if (!ptr)
    return;
  s->malloc_count--;
  s->malloc_size -= fos_js_usable_size(ptr) + FOS_JS_MALLOC_OVERHEAD;
  free(ptr);
}

static void *fos_js_realloc(JSMallocState *s, void *ptr, size_t size) {
  size_t old_size;
  if (!ptr) {
    if (size == 0)
      return NULL;
    return fos_js_malloc(s, size);
  }
  old_size = fos_js_usable_size(ptr);
  if (size == 0) {
    s->malloc_count--;
    s->malloc_size -= old_size + FOS_JS_MALLOC_OVERHEAD;
    free(ptr);
    return NULL;
  }
  if (s->malloc_size + size - old_size > s->malloc_limit)
    return NULL;
  ptr = realloc(ptr, size);
  if (!ptr)
    return NULL;
  s->malloc_size += fos_js_usable_size(ptr) - old_size;
  return ptr;
}

static const JSMallocFunctions fos_js_malloc_funcs = {
    fos_js_malloc,
    fos_js_free,
    fos_js_realloc,
    fos_js_usable_size,
};

JSRuntime *fos_js_new_runtime_wasm(void) {
  return JS_NewRuntime2(&fos_js_malloc_funcs, NULL);
}
