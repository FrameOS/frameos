#include "fos_battery_filter.h"

#include <stddef.h>

/* Insertion sort: n is FOS_BATTERY_ROUND_SAMPLES, and at that size it beats
 * anything with a call in its inner loop. */
static void sort_ints(int *v, int n)
{
    for (int i = 1; i < n; i++) {
        int key = v[i];
        int j = i - 1;
        while (j >= 0 && v[j] > key) {
            v[j + 1] = v[j];
            j--;
        }
        v[j + 1] = key;
    }
}

int fos_battery_median(int *scratch, int n)
{
    if (scratch == NULL || n <= 0) return -1;
    sort_ints(scratch, n);
    return scratch[n / 2];
}

void fos_battery_burst_reset(fos_battery_burst_t *burst)
{
    if (burst == NULL) return;
    burst->count = 0;
    for (int i = 0; i < FOS_BATTERY_MAX_ROUNDS; i++) burst->rounds[i] = -1;
}

bool fos_battery_burst_add(fos_battery_burst_t *burst, int round_median)
{
    if (burst == NULL || round_median < 0) return false;
    if (burst->count >= FOS_BATTERY_MAX_ROUNDS) return true;

    int previous = burst->count > 0 ? burst->rounds[burst->count - 1] : -1;
    burst->rounds[burst->count++] = round_median;
    /* Out of rounds: stop, settled or not. The caller's loop bound says the
     * same thing, but a reducer whose "stop" answer depends on the caller
     * counting correctly is one refactor from sampling forever. */
    if (burst->count >= FOS_BATTERY_MAX_ROUNDS) return true;
    if (previous < 0) return false;

    int drift = round_median - previous;
    if (drift < 0) drift = -drift;
    return drift <= FOS_BATTERY_SETTLED_COUNTS;
}

int fos_battery_burst_value(const fos_battery_burst_t *burst)
{
    if (burst == NULL) return -1;
    int best = -1;
    for (int i = 0; i < burst->count; i++) {
        if (burst->rounds[i] > best) best = burst->rounds[i];
    }
    return best;
}
