#include "fos_wake.h"

uint64_t fos_wake_button_mask(const int *pins, size_t count, uint64_t valid_mask,
                              uint64_t held_mask, uint64_t *skipped_mask)
{
    uint64_t armed = 0;
    uint64_t skipped = 0;
    for (size_t i = 0; i < count; i++) {
        int pin = pins ? pins[i] : -1;
        if (pin < 0 || pin > 63) {
            continue; /* not a GPIO at all; nothing to report per pin */
        }
        uint64_t bit = 1ULL << pin;
        if ((valid_mask & bit) == 0 || (held_mask & bit) != 0) {
            skipped |= bit;
            continue;
        }
        armed |= bit;
    }
    if (skipped_mask) *skipped_mask = skipped;
    return armed;
}

int fos_wake_button_index(const int *pins, size_t count, uint64_t status_mask)
{
    int best = -1;
    for (size_t i = 0; i < count; i++) {
        int pin = pins ? pins[i] : -1;
        if (pin < 0 || pin > 63) continue;
        if ((status_mask & (1ULL << pin)) == 0) continue;
        if (best < 0 || pin < pins[best]) best = (int)i;
    }
    return best;
}
