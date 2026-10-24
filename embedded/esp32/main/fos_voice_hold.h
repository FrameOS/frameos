/*
 * The key hold that starts a voice chat session (docs/voice-chat.md), pure:
 * the button task feeds it one key's level every poll and acts on what comes
 * back. No IDF here, so main/tests/test_fos_voice_hold.c runs it on a laptop;
 * fos_buttons.c owns the GPIO and decides WHICH keys are voice keys (the
 * frame's event map, fos_voice_binding.c), fos_voice.c the microphone and
 * the upload.
 *
 * A voice key down for FOS_VOICE_HOLD_MS — the contract's long press — starts
 * a session; up before that is nothing (a press, as it always was); up after
 * the start ends it. From the start until the release the key is claimed: its
 * up makes no sound and no `button` (fos_buttons.c), so the long press the
 * dispatcher would otherwise make of the hold never happens.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "fos_events_gen.h"

/* How long the key stays down before the frame starts listening: the
 * contract's `buttons.longPressMs`, so "long press" means one thing on the
 * frame and in Settings → Button actions. */
#define FOS_VOICE_HOLD_MS FOS_BUTTON_LONG_PRESS_MS

typedef enum {
    FOS_VOICE_HOLD_NONE = 0, /* nothing to do */
    FOS_VOICE_HOLD_START,    /* held long enough: start listening */
    FOS_VOICE_HOLD_END,      /* let go after the start: stop listening */
} fos_voice_hold_event_t;

typedef struct {
    bool down;          /* the key was down at the last sample */
    int64_t down_at_ms; /* when it went down */
    bool active;        /* a session started and the key has not let go */
    bool claimed;       /* the key belongs to the hold until it is up again */
} fos_voice_hold_t;

void fos_voice_hold_init(fos_voice_hold_t *h);

/* One poll: the key's state (true = down) at `now_ms`. */
fos_voice_hold_event_t fos_voice_hold_sample(fos_voice_hold_t *h, bool down, int64_t now_ms);

/* The hold owns the key: no hold sounds, no release click, and its `up` edge
 * carries `claimed`. True from the start until the key is up again. */
bool fos_voice_hold_claimed(const fos_voice_hold_t *h);
