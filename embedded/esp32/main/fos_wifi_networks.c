#include "fos_wifi_networks.h"

#include <string.h>

static int fold(unsigned char c)
{
    return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c;
}

static int compare(const char *a, const char *b)
{
    const unsigned char *x = (const unsigned char *)a;
    const unsigned char *y = (const unsigned char *)b;
    while (*x && fold(*x) == fold(*y)) {
        x++;
        y++;
    }
    int order = fold(*x) - fold(*y);
    return order ? order : strcmp(a, b);
}

/* An insertion sort: 64 names at most, once a scan, and no qsort to link. */
void fos_wifi_networks_sort(fos_wifi_network_t *networks, int count)
{
    for (int i = 1; i < count; i++) {
        fos_wifi_network_t moving = networks[i];
        int j = i;
        for (; j > 0 && compare(networks[j - 1].ssid, moving.ssid) > 0; j--) networks[j] = networks[j - 1];
        networks[j] = moving;
    }
}
