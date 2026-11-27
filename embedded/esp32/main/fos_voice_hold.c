#include "fos_voice_hold.h"

void fos_voice_hold_init(fos_voice_hold_t *h)
{
    *h = (fos_voice_hold_t){0};
}

fos_voice_hold_event_t fos_voice_hold_sample(fos_voice_hold_t *h, bool down, bool others_down, int64_t now_ms)
{
    if (down && !h->down) {
        h->down_at_ms = now_ms;
        h->chord = false;
    }
    h->down = down;
    if (!down) h->chord = false;

    if (h->active) {
        if (!down) {
            /* Let go: the session is over, and with it the claim. The
             * release edge itself was queued by the poll that saw it, while
             * the claim still held (fos_buttons.c samples the hold on the
             * levels the previous poll accepted). */
            h->active = false;
            h->claimed = false;
            return FOS_VOICE_HOLD_END;
        }
        return FOS_VOICE_HOLD_NONE;
    }
    if (down && others_down) h->chord = true;
    if (down && !h->chord && now_ms - h->down_at_ms >= FOS_VOICE_HOLD_MS) {
        h->active = true;
        h->claimed = true;
        return FOS_VOICE_HOLD_START;
    }
    return FOS_VOICE_HOLD_NONE;
}

bool fos_voice_hold_claimed(const fos_voice_hold_t *h)
{
    return h->claimed;
}
