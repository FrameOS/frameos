#include "fos_power.h"

#include <string.h>

static uint8_t bump(uint8_t streak)
{
    return streak < 255 ? (uint8_t)(streak + 1) : streak;
}

void fos_power_decide(const fos_power_input_t *in, fos_power_state_t *state,
                      fos_power_decision_t *out)
{
    memset(out, 0, sizeof(*out));
    int mv = in->mv > 0 ? in->mv : 0;
    bool seen_cell = state->last_good_mv >= FOS_POWER_PRESENT_MV;

    if (mv >= FOS_POWER_PRESENT_MV) {
        state->low_streak = 0;
        bool implausible = seen_cell &&
                           mv < state->last_good_mv - FOS_POWER_GLITCH_DROP_MV;
        if (implausible) {
            /* Believe the drop only once it repeats: a single burst that
             * reads 0.6 V low is the ADC, not the cell. Until then the
             * decision runs on the last believed value. */
            state->drop_streak = bump(state->drop_streak);
            if (state->drop_streak >= FOS_POWER_CONFIRM_PASSES) {
                state->drop_streak = 0;
                state->last_good_mv = mv;
            } else {
                out->suspect = true;
            }
        } else {
            state->drop_streak = 0;
            state->last_good_mv = mv;
        }
        out->mv_used = state->last_good_mv;
        out->on_battery = true;
    } else {
        /* Below the presence threshold (or no reading at all). A cell that
         * was there a pass ago does not vanish for one burst; it is gone
         * once the reading repeats. */
        state->low_streak = bump(state->low_streak);
        state->drop_streak = 0;
        if (seen_cell && state->low_streak < FOS_POWER_CONFIRM_PASSES) {
            out->on_battery = true;
            out->suspect = true;
            out->mv_used = state->last_good_mv;
        } else {
            out->on_battery = false;
            out->mv_used = mv;
            if (state->low_streak >= FOS_POWER_CONFIRM_PASSES) {
                state->last_good_mv = 0; /* start over when a cell returns */
            }
        }
    }

    /* Critical: the believed value, two passes running. A suspect pass never
     * counts toward it (its own reading was just disbelieved), and a pass
     * without a cell cannot be critical. */
    bool critical_now = out->on_battery && !out->suspect &&
                        out->mv_used > 0 && out->mv_used <= FOS_POWER_CRITICAL_MV;
    if (critical_now) {
        state->critical_streak = bump(state->critical_streak);
    } else {
        state->critical_streak = 0;
    }
    out->critical = state->critical_streak >= FOS_POWER_CONFIRM_PASSES;
    if (critical_now && !out->critical) {
        out->suspect = true; /* first critical read: render, but say so */
    }

    /* A critical cell is a battery by definition, so deep_sleep_on_battery
     * sleeps on it even when the presence test above was lost — the whole
     * point of the critical branch is to stop spending the cell. */
    out->deep_sleep = in->deep_sleep ||
                      (in->deep_sleep_on_battery && (out->on_battery || out->critical));
}
