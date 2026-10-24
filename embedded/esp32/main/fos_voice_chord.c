#include "fos_voice_chord.h"

void fos_voice_chord_init(fos_voice_chord_t *c)
{
    *c = (fos_voice_chord_t){0};
}

fos_voice_chord_event_t fos_voice_chord_sample(fos_voice_chord_t *c, bool left_down, bool right_down,
                                               int64_t now_ms)
{
    bool both = left_down && right_down;
    if (both && !c->both_down) {
        c->both_at_ms = now_ms;
    }
    c->both_down = both;

    if (c->active) {
        if (!both) {
            /* A key let go: the session is over. The keys stay claimed until
             * both are up, so the second release is silent too. */
            c->active = false;
            c->claimed = left_down || right_down;
            return FOS_VOICE_CHORD_END;
        }
        return FOS_VOICE_CHORD_NONE;
    }
    if (c->claimed) {
        /* The other key of a finished session still down: nothing starts
         * until both are up, so a lingering thumb cannot start a second
         * session on its own. */
        if (!left_down && !right_down) c->claimed = false;
        return FOS_VOICE_CHORD_NONE;
    }
    if (both && now_ms - c->both_at_ms >= FOS_VOICE_CHORD_HOLD_MS) {
        c->active = true;
        c->claimed = true;
        return FOS_VOICE_CHORD_START;
    }
    return FOS_VOICE_CHORD_NONE;
}

bool fos_voice_chord_claimed(const fos_voice_chord_t *c)
{
    return c->claimed;
}
