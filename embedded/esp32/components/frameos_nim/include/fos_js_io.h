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
 * it (the app is answered at once). The strings and the body are copied.
 * `piece_bytes` > 0 asks for the answer in pieces of that size (fetch's
 * onChunk): each a FOS_JS_IO_PIECE answer, then one FOS_JS_IO_END. */
bool fos_js_io_submit(int id, const char *method, const char *url, const char *headers, size_t headers_len,
                      const void *body, size_t body_len, int timeout_ms, size_t max_bytes, size_t piece_bytes);

/* Runs `job(arg)` on the task, after what is queued; false when it cannot be
 * queued or the task cannot start (no internal RAM). */
bool fos_js_io_run(void (*job)(void *), void *arg);

/* What an answer is. A whole one: `chunks` is the glue's chunk array of
 * `count` (status 0 is no response: the one chunk, or none, is the reason).
 * A piece of a streamed body: `chunks` is its `count` bytes. A stream's end:
 * `chunks` is why it was cut short, a string, or NULL (status 0: there was
 * no response at all). A piece's bytes, an end's reason and `head` are
 * malloc()ed and the taker's to free(). */
#define FOS_JS_IO_WHOLE 0
#define FOS_JS_IO_PIECE 1
#define FOS_JS_IO_END 2
/* A stream's first answer has its head, one string: the URL the answer came
 * from when a redirect was followed (else nothing), a line break, and the
 * response's headers as "name: value\n" lines. */
#define FOS_JS_IO_URL_BYTES 1024
#define FOS_JS_IO_HEAD_BYTES (FOS_JS_IO_URL_BYTES + 2048)

/* One answer, oldest first: false when none is waiting, or comes within
 * `wait_ms` (a fetch made in the call, where nothing pumps promises). */
bool fos_js_io_take(int *id, int *status, void **chunks, size_t *count, int *kind, char **head, int wait_ms);

/* Stops the stream `id` if it is the one being read: its connection is
 * closed and no more of it is queued. What was queued already still comes
 * (the taker drops it), and one not started yet is stopped the same way
 * when its first piece is dropped. */
void fos_js_io_cancel(int id);

/* Requests handed over and not taken back. */
int fos_js_io_in_flight(void);

/* The pump stopped with answers still waiting: wake the render task's wait
 * again for them. */
void fos_js_io_wake_if_waiting(void);

#endif
