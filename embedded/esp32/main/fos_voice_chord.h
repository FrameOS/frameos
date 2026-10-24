/*
 * The two-button chord that starts a voice chat session (docs/voice-chat.md),
 * pure: the button task feeds it the LEFT and RIGHT keys' levels every poll
 * and acts on what comes back. No IDF here, so main/tests/test_fos_voice_chord.c
 * runs it on a laptop; fos_buttons.c owns the GPIO and fos_voice.c the
 * microphone and the upload.
 *
 * Both keys down for FOS_VOICE_CHORD_HOLD_MS starts a session; either key up
 * before that is nothing (two presses, as they always were); either key up
 * after the start ends it. While a session runs both keys are claimed: their
 * ups make no sound and no `button` (fos_buttons.c), and the chord takes no
 * new start until both are up again.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* How long both keys stay down before the frame starts listening. Short
 * enough to feel immediate, long enough that a thumb landing on both keys
 * on the way to one of them is still two presses. */
#define FOS_VOICE_CHORD_HOLD_MS 500

typedef enum {
    FOS_VOICE_CHORD_NONE = 0, /* nothing to do */
    FOS_VOICE_CHORD_START,    /* both held long enough: start listening */
    FOS_VOICE_CHORD_END,      /* a key let go after the start: stop listening */
} fos_voice_chord_event_t;

typedef struct {
    bool both_down;      /* both keys were down at the last sample */
    int64_t both_at_ms;  /* when both became down */
    bool active;         /* a session started and neither key has let go */
    bool claimed;        /* the keys belong to the chord until both are up */
} fos_voice_chord_t;

void fos_voice_chord_init(fos_voice_chord_t *c);

/* One poll: the two keys' states (true = down) at `now_ms`. */
fos_voice_chord_event_t fos_voice_chord_sample(fos_voice_chord_t *c, bool left_down, bool right_down,
                                               int64_t now_ms);

/* The chord owns the keys: no hold sounds, no release click, and their `up`
 * edges carry `claimed`. True from the start until both keys are up again. */
bool fos_voice_chord_claimed(const fos_voice_chord_t *c);
