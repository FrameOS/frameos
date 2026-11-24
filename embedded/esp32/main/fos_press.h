/*
 * A press shows at once (docs/realtime-rendering.md "A press shows at
 * once"): what the touch task and the render task decide about the moment
 * a finger lands, before the scene's own answer is drawn. The drawing is the
 * panel's (an LCD's shade, lcd_press.h; e-paper's ink, fos_client.c); the
 * rules are here.
 *
 * Pure: no IDF, so main/tests/test_fos_press.c runs it on the host.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* An LCD's lit press stays this long after the lift when no picture comes
 * (a handler that changed nothing): long enough to be seen, short of the
 * time a slow answer takes, whose picture puts it away first. */
#define FOS_PRESS_LINGER_MS 250

/* A finger that has slid this far (panel pixels) from where it landed is a
 * drag, not a press: its light goes. GestureTapSlopPx's sense. */
#define FOS_PRESS_SLOP_PX 12

/* E-paper inks a press (the element's box inverted with one DU, ~0.45 s on
 * the IT8951) only on a scene whose taps take at least this long to answer
 * (contact to the answer's picture ready): a faster answer would wait for the
 * ink's waveform, and the ink would cost what it is meant to hide. */
#define FOS_PRESS_INK_AFTER_MS 600

/* The waveform that draws an answer on e-paper (DU on the IT8951): the busy
 * light stays on this long after it starts. */
#define FOS_PRESS_WAVEFORM_MS 450

/* How long a scene's taps take to answer, smoothed over the last few:
 * `previous` 0 is none yet. */
uint32_t fos_press_answer_average(uint32_t previous_ms, uint32_t sample_ms);

/* Whether a press is inked on an element whose taps take `average_ms` (0:
 * none answered yet, so no). */
bool fos_press_ink_wanted(uint32_t average_ms);

/* How long the last few elements pressed took to answer, by their box: a
 * scene's slow button inks, its quick ones beside it do not. The least
 * recently pressed goes when a new box needs room. Emptied when the scene
 * changes. */
#define FOS_PRESS_ANSWERS 8
typedef struct {
    int box[4];
    uint32_t ms;   /* fos_press_answer_average of its taps; 0: free */
    uint32_t used; /* when it was last pressed, in notes */
} fos_press_answer_t;
typedef struct {
    fos_press_answer_t entries[FOS_PRESS_ANSWERS];
    uint32_t clock;
} fos_press_answers_t;
/* The box's smoothed answer, 0 when it has none. */
uint32_t fos_press_answers_get(const fos_press_answers_t *answers, const int box[4]);
/* A tap on the box took `ms` to answer. */
void fos_press_answers_note(fos_press_answers_t *answers, const int box[4], uint32_t ms);
void fos_press_answers_clear(fos_press_answers_t *answers);

/* Whether a finger `dx`, `dy` from where it landed has moved off its press. */
bool fos_press_moved_off(int dx, int dy);

/* The ink: sixteen-grey bytes (two pixels each, either nibble order) as the
 * other extreme in pure black and white, the light pixels black and the dark
 * ones white, which a DU draws exactly. In place. */
void fos_press_ink_gray4(uint8_t *bytes, size_t len);
