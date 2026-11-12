/*
 * Host tests for the order of the networks in the frame settings' select box
 * (fos_wifi_networks.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_wifi_networks.c main/tests/test_fos_wifi_networks.c \
 *      -o /tmp/test_fos_wifi_networks && /tmp/test_fos_wifi_networks
 *
 * (backend/app/tasks/tests/test_esp32_wifi_networks.py does exactly that in CI.)
 *
 * A scan hands the names over strongest first, which moves with every scan
 * and puts a neighbour's network above the one looked for: the list is read
 * by name, so it is sorted by name, and each name keeps its own signal.
 */
#include <stdio.h>
#include <string.h>

#include "fos_wifi_networks.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        checks++;                                                                      \
        if (!(cond)) {                                                                 \
            failures++;                                                                \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                    \
        }                                                                              \
    } while (0)

static int fill(fos_wifi_network_t *list, const char *const *names, int count)
{
    for (int i = 0; i < count; i++) {
        memset(&list[i], 0, sizeof(list[i]));
        strncpy(list[i].ssid, names[i], sizeof(list[i].ssid) - 1);
        list[i].rssi = (int8_t)(-30 - i); /* strongest first, as a scan gives them */
    }
    return count;
}

static void check_order(const fos_wifi_network_t *list, const char *const *names, int count)
{
    for (int i = 0; i < count; i++) {
        if (strcmp(list[i].ssid, names[i]) != 0) printf("  at %d: \"%s\", expected \"%s\"\n", i, list[i].ssid, names[i]);
        CHECK(strcmp(list[i].ssid, names[i]) == 0);
    }
}

static void test_by_name(void)
{
    const char *scanned[] = { "Home", "Cafe", "Network 2", "attic", "Network 0", "Network 1" };
    const char *sorted[] = { "attic", "Cafe", "Home", "Network 0", "Network 1", "Network 2" };
    fos_wifi_network_t list[6];
    int count = fill(list, scanned, 6);
    fos_wifi_networks_sort(list, count);
    check_order(list, sorted, count);
}

static void test_signal_travels_with_its_name(void)
{
    const char *scanned[] = { "Zebra", "Mango", "Apple" };
    fos_wifi_network_t list[3];
    int count = fill(list, scanned, 3);
    fos_wifi_networks_sort(list, count);
    CHECK(strcmp(list[0].ssid, "Apple") == 0 && list[0].rssi == -32);
    CHECK(strcmp(list[1].ssid, "Mango") == 0 && list[1].rssi == -31);
    CHECK(strcmp(list[2].ssid, "Zebra") == 0 && list[2].rssi == -30);
}

static void test_case_and_prefixes(void)
{
    /* Case does not split the alphabet in two; a name comes before the
     * longer ones that start with it; names alike but for case have one
     * order whichever the scan gave first. */
    const char *scanned[] = { "home", "Zoo", "HOME", "Home 5G", "Home", "apple", "Home-Guest", "_printer", "1st floor" };
    const char *sorted[] = { "1st floor", "_printer", "apple", "HOME", "Home", "home", "Home 5G", "Home-Guest", "Zoo" };
    fos_wifi_network_t list[9];
    int count = fill(list, scanned, 9);
    fos_wifi_networks_sort(list, count);
    check_order(list, sorted, count);

    const char *again[] = { "Home", "HOME", "home" };
    const char *again_sorted[] = { "HOME", "Home", "home" };
    count = fill(list, again, 3);
    fos_wifi_networks_sort(list, count);
    check_order(list, again_sorted, count);
}

static void test_utf8_and_full_length(void)
{
    /* Bytes above ASCII are compared unsigned: a UTF-8 name sorts after the
     * ASCII ones, never before them through a signed char. A 32-byte name
     * (the longest there is) is carried whole. */
    const char *scanned[] = { "\xc3\x96sterg\xc3\xa5rd", "zzz", "12345678901234567890123456789012", "Caf\xc3\xa9", "Cafe" };
    const char *sorted[] = { "12345678901234567890123456789012", "Cafe", "Caf\xc3\xa9", "zzz", "\xc3\x96sterg\xc3\xa5rd" };
    fos_wifi_network_t list[5];
    int count = fill(list, scanned, 5);
    fos_wifi_networks_sort(list, count);
    check_order(list, sorted, count);
}

static void test_small_and_full_lists(void)
{
    fos_wifi_network_t list[FOS_WIFI_SCAN_MAX];
    fos_wifi_networks_sort(list, 0); /* no scan results: nothing read */
    const char *one[] = { "Only" };
    int count = fill(list, one, 1);
    fos_wifi_networks_sort(list, count);
    check_order(list, one, 1);

    /* A full list handed over in reverse: the worst case for the sort. */
    for (int i = 0; i < FOS_WIFI_SCAN_MAX; i++) {
        memset(&list[i], 0, sizeof(list[i]));
        snprintf(list[i].ssid, sizeof(list[i].ssid), "Network %02d", FOS_WIFI_SCAN_MAX - 1 - i);
        list[i].rssi = (int8_t)(-20 - i);
    }
    fos_wifi_networks_sort(list, FOS_WIFI_SCAN_MAX);
    for (int i = 0; i < FOS_WIFI_SCAN_MAX; i++) {
        char expected[33];
        snprintf(expected, sizeof(expected), "Network %02d", i);
        CHECK(strcmp(list[i].ssid, expected) == 0);
        CHECK(list[i].rssi == (int8_t)(-20 - (FOS_WIFI_SCAN_MAX - 1 - i)));
    }
}

int main(void)
{
    test_by_name();
    test_signal_travels_with_its_name();
    test_case_and_prefixes();
    test_utf8_and_full_length();
    test_small_and_full_lists();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
