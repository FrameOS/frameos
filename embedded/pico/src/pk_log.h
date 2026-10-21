// The device's own log ring.
//
// Everything the firmware says goes through pk_logf()/pk_log_event(): to the
// USB console right away, and into a ring that outlives whoever was (not)
// listening — `usb_api logs`, `GET /logs` and the batched upload to the
// backend's /api/log all read it. The ESP32 thin client keeps its ring inside
// the Nim glue it does not link, so its log surfaces are all empty; the Pico
// owns the ring so that mistake is not copied.
//
// Portable (the clock and the console are injected), host-tested
// (tests/test_pk_log.c). Single-threaded by design: the firmware runs one
// poll loop and never logs from an interrupt.
#ifndef PK_LOG_H
#define PK_LOG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef PK_LOG_SLOTS
#define PK_LOG_SLOTS 64
#endif
#define PK_LOG_LINE_MAX 288

// Unix epoch seconds, or 0 while the clock is not synced.
typedef uint32_t (*pk_log_clock_fn)(void);
// Receives each finished line (no trailing newline).
typedef void (*pk_log_sink_fn)(const char *line);
typedef void (*pk_log_write_fn)(void *arg, const char *data, size_t len);

void pk_log_init(pk_log_clock_fn clock, pk_log_sink_fn console);

// A plain message. Uploaded as {"event":"log","source":"pico","message":…}.
void pk_logf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
// A structured event: `json` must be one JSON object and is uploaded as is
// (the backend files it under its "event" key, e.g. render:scene).
void pk_log_event(const char *json);

// "<epoch|-> <line>\n" per retained entry, oldest first — the `usb_api logs`
// / GET /logs wire format (frontend/src/models/embeddedUsbLogsModel.ts).
void pk_log_dump(pk_log_write_fn write, void *arg);

// Upload batching. build_batch writes {"logs":[…]} for entries not yet
// acknowledged, as many as fit in `cap`, and returns the body length (0 when
// there is nothing to send). `*cursor` receives the token to hand to
// pk_log_mark_uploaded() once the POST succeeded. Entries overwritten before
// they were uploaded are reported once as a log:dropped event.
size_t pk_log_build_batch(char *out, size_t cap, uint32_t *cursor);
void pk_log_mark_uploaded(uint32_t cursor);
bool pk_log_upload_pending(void);

#endif // PK_LOG_H
