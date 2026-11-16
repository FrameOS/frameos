#ifndef FOS_REFRESH_QUEUE_H
#define FOS_REFRESH_QUEUE_H

/*
 * The pictures owed to an e-paper panel whose full refresh runs on the
 * display's own task (frameos_display.c refresh_task). Whoever asks for a
 * refresh hands its picture over and goes on: the reTerminal E1002's color
 * refresh is 28.7 s, and its render task used to sit out all of it.
 *
 * Two places: the picture on its way to the glass (`now`, the refresh task's
 * alone while it shows it) and the one after it (`next`). A picture asked for
 * while a refresh runs goes to `next`, over whatever waited there: the glass
 * catches up with what the frame shows now, not with every frame between.
 *
 * No locking and no IDF: the caller holds its lock around every call.
 * Host-tested (main/tests/test_fos_refresh_queue.c).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *now;  /* on its way to the glass */
    uint8_t *next; /* the newest asked for after it */
    size_t len;    /* of both */
    bool busy;     /* a picture is owed: from the first put to the last done */
    void *(*alloc)(size_t len);
    void (*release)(void *buf);
    /* A buffer taken as it is, not copied: a colour panel's picture packed in
     * the scene canvas (main.c canvas_holds_panel_picture), which nothing
     * writes while the queue holds it (fos_refresh_queue_holds; the render
     * waits). NULL: every picture is copied. */
    const uint8_t *lent;
    bool now_lent, next_lent; /* that slot is `lent` itself: never released */
} fos_refresh_queue_t;

typedef enum {
    FOS_REFRESH_STARTED,   /* the queue was idle: wake the refresh task */
    FOS_REFRESH_QUEUED,    /* a refresh runs: this one is next */
    FOS_REFRESH_NO_MEMORY, /* nothing changed: refresh in place */
} fos_refresh_put_t;

/* A copy of `buf` owed to the glass; `buf` itself when it is `lent`. */
fos_refresh_put_t fos_refresh_queue_put(fos_refresh_queue_t *queue, const uint8_t *buf, size_t len);

/* The refresh task: the picture to show now, NULL when none is owed. */
const uint8_t *fos_refresh_queue_current(const fos_refresh_queue_t *queue);

/* The refresh task, once `current` is on the glass: true when another picture
 * waits (it is current now); false when the queue went idle. */
bool fos_refresh_queue_done(fos_refresh_queue_t *queue);

/* Whether `buf` is a picture owed to the glass as it is (`lent`): whoever
 * writes it waits until this is false. */
bool fos_refresh_queue_holds(const fos_refresh_queue_t *queue, const uint8_t *buf);

/* Whether a picture is owed (a timed render waits for it, a park leaves the
 * panel to the refresh task). */
bool fos_refresh_queue_busy(const fos_refresh_queue_t *queue);

#endif
