// Console lines that wait for the panel.
//
// The console is read on every outermost pk_poll(), and a render pass spends
// ~30 s inside pk_poll() waiting on the panel's BUSY line: so `status` and
// `logs` answer mid-refresh, but a command that would pull the panel's pins,
// its settings or the power from under the driver (`set`, `wifi`, `restart`,
// `factory-reset`, `bootsel`, in either dialect) must not run until the pass
// is over — the ESP32 holds such work for its render task the same way. Those
// lines are queued here and run, in order, on the first console turn after
// the pass ends.
//
// Portable, host-tested (tests/test_pk_console_queue.c).
#ifndef PK_CONSOLE_QUEUE_H
#define PK_CONSOLE_QUEUE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PK_CONSOLE_QUEUE_SLOTS 4
#define PK_CONSOLE_QUEUE_LINE_MAX 512

typedef struct {
    char lines[PK_CONSOLE_QUEUE_SLOTS][PK_CONSOLE_QUEUE_LINE_MAX];
    uint8_t head;
    uint8_t count;
} pk_console_queue_t;

// True for a line that must wait while a render pass holds the panel.
// `line` is not modified.
bool pk_console_waits_for_panel(const char *line);
// True for a line in the framed `usb_api` dialect (answered only in frames).
bool pk_console_is_usb_api(const char *line);

void pk_console_queue_init(pk_console_queue_t *queue);
// False when the queue is full or the line too long; nothing is stored then.
bool pk_console_queue_push(pk_console_queue_t *queue, const char *line);
// Oldest line first; false when empty.
bool pk_console_queue_pop(pk_console_queue_t *queue, char *out, size_t cap);

#endif // PK_CONSOLE_QUEUE_H
