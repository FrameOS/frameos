#include "fos_usj_attach.h"

bool fos_usj_attach_poll(fos_usj_attach_t *state, bool pads_claimed, bool host_connected)
{
    if (state->installed) return false;
    if (pads_claimed || !host_connected) {
        state->seen = 0;
        return false;
    }
    if (state->seen < FOS_USJ_ATTACH_POLLS) state->seen++;
    if (state->seen < FOS_USJ_ATTACH_POLLS) return false;
    state->installed = true;
    return true;
}
