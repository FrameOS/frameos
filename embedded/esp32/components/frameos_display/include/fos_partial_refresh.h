#ifndef FOS_PARTIAL_REFRESH_H
#define FOS_PARTIAL_REFRESH_H

/*
 * Whether an e-paper panel with a partial waveform takes this picture as a
 * partial update or a full refresh (fos_display_update).
 *
 * A partial update moves only the pixels that differ between the panel's two
 * RAM planes, with no flash, and needs the picture on the glass to be known
 * exactly. It leaves a little ghost behind each time, so a full refresh clears
 * them every FOS_PARTIAL_MAX_BEFORE_FULL updates, and a new scene or a picture
 * that mostly changed starts from a clean panel.
 *
 * That refresh is seconds in which a tap goes unanswered, so while someone is
 * tapping the ghosts wait, FOS_PARTIAL_MAX_WHILE_INPUT updates at the most,
 * and the idle frame clears them (fos_display_park_if_idle).
 *
 * Pure: no IDF, so main/tests/test_fos_partial_refresh.c runs it on the host.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FOS_PARTIAL_MAX_BEFORE_FULL 20
#define FOS_PARTIAL_MAX_WHILE_INPUT 120

typedef struct {
    bool supported;       /* the panel has a partial waveform */
    bool glass_known;     /* the bytes on the glass are held in memory */
    bool same_scene;      /* the scene the last picture on the glass came from */
    bool input_recent;    /* someone is tapping */
    uint32_t partials_since_full;
    size_t changed_bytes;
    size_t total_bytes;
} fos_partial_refresh_input_t;

bool fos_partial_refresh_wanted(const fos_partial_refresh_input_t *input);

/* How many of the `len` bytes differ. */
size_t fos_partial_changed_bytes(const uint8_t *a, const uint8_t *b, size_t len);

#endif
