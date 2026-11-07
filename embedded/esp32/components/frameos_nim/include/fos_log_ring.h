/* The console's log lines, written by a task of their own.
 *
 * Every FrameOS log line (frameos_nim_log_hook's JSON, the firmware's
 * "render #N ..." lines) used to be a printf on the task that logged it, and
 * on an LCD board that task is the render task. ESP-IDF's UART VFS writes a
 * line one character per call through the driver's 2 KB TX ring at 115200
 * baud (11.5 characters a millisecond), so the ten lines of an isolated tap
 * (~2.2 KB) held the render task ~150 ms, ~60 of them between the finished
 * render and the buffer switch (docs/perf-todo.md, 2026-11-07). The lines go
 * into this ring instead, and a low-priority task on the other core prints
 * them: the logging task pays a memcpy.
 *
 * Before fos_log_ring_start() (early boot) and when the ring cannot be
 * allocated, fos_log_ring_puts prints synchronously, as before. A full ring
 * drops the newest line and says so once it drains. Lines queued at a crash
 * are lost unless fos_log_ring_flush ran: the restart paths and the deep
 * sleep call it. */
#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Allocates the ring (PSRAM when there is one) and starts the drain task.
 * Idempotent. */
void fos_log_ring_start(void);

/* Queues one line (no trailing newline; one is printed after it). */
void fos_log_ring_puts(const char *line);

/* printf into the ring, one line. Returns the length formatted. */
int fos_log_ring_printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* Waits until every queued line has been written, or timeout_ms passed.
 * Returns true when the ring is empty. */
bool fos_log_ring_flush(uint32_t timeout_ms);

/* Lines dropped because the ring was full, since boot. */
uint32_t fos_log_ring_dropped(void);

/* Lines queued and not yet printed. */
size_t fos_log_ring_pending(void);

#ifdef __cplusplus
}
#endif
