#include "fos_partial_refresh.h"

bool fos_partial_refresh_wanted(const fos_partial_refresh_input_t *input)
{
    if (!input->supported || !input->glass_known || !input->same_scene) return false;
    uint32_t most = input->input_recent ? FOS_PARTIAL_MAX_WHILE_INPUT : FOS_PARTIAL_MAX_BEFORE_FULL;
    if (input->partials_since_full >= most) return false;
    return input->changed_bytes * 2 < input->total_bytes;
}

size_t fos_partial_changed_bytes(const uint8_t *a, const uint8_t *b, size_t len)
{
    size_t changed = 0;
    for (size_t i = 0; i < len; i++) {
        if (a[i] != b[i]) changed++;
    }
    return changed;
}
