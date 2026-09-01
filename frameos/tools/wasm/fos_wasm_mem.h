/* See fos_wasm_mem.c: a simulated device memory ceiling for the preview. */
#ifndef FOS_WASM_MEM_H
#define FOS_WASM_MEM_H

#include <stddef.h>

/* frameos_wasm_render's out-of-memory result, distinct from its 0/1/2. */
#define FOS_WASM_RENDER_OOM 3

void *fos_wasm_malloc(size_t size);
void *fos_wasm_calloc(size_t count, size_t size);
void *fos_wasm_realloc(void *ptr, size_t size);
void fos_wasm_free(void *ptr);
void fos_wasm_fatal_oom(size_t size);

void frameos_wasm_set_memory_limit(unsigned int bytes, unsigned int reserve);
unsigned int frameos_wasm_memory_render_headroom(void);
unsigned int frameos_wasm_memory_limit(void);
unsigned int frameos_wasm_memory_used(void);
unsigned int frameos_wasm_memory_peak(void);
unsigned int frameos_wasm_memory_failed(void);
void frameos_wasm_memory_reset_peak(void);

#endif /* FOS_WASM_MEM_H */
