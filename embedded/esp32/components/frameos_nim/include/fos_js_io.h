#ifndef FOS_JS_IO_H
#define FOS_JS_IO_H

/* The network work scenes ask for, on one task (fos_js_io.c,
 * docs/async-js.md): async JavaScript's requests, and jobs (the scene
 * store's). Called from the Nim side (js_runtime/js_io.nim) on the
 * render task; the answers' chunks are the glue's (frameos_nim.h) and the
 * taker frees them with fos_nim_http_free_chunks. */

#include <stdbool.h>
#include <stddef.h>

/* Queues one request; false when the queue is full or there is no memory for
 * it (the app is answered at once). The strings and the body are copied. */
bool fos_js_io_submit(int id, const char *method, const char *url, const char *headers, size_t headers_len,
                      const void *body, size_t body_len, int timeout_ms, size_t max_bytes);

/* Runs `job(arg)` on the task, after what is queued; false when it cannot be
 * queued or the task cannot start (no internal RAM). */
bool fos_js_io_run(void (*job)(void *), void *arg);

/* One answer, oldest first: false when none is waiting. Status 0 is no
 * response: the one chunk (or none) is the reason. */
bool fos_js_io_take(int *id, int *status, void **chunks, size_t *count);

/* Requests handed over and not taken back. */
int fos_js_io_in_flight(void);

/* The pump stopped with answers still waiting: wake the render task's wait
 * again for them. */
void fos_js_io_wake_if_waiting(void);

#endif
