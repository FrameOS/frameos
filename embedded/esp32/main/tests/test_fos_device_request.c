/*
 * Host tests for queued deploy requests (fos_device_request.c).
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_device_request.c main/tests/test_fos_device_request.c \
 *      -o /tmp/test_fos_device_request && /tmp/test_fos_device_request
 *
 * (backend/app/tasks/tests/test_esp32_device_request.py does exactly that in CI.)
 */
#include <stdio.h>
#include <string.h>

#include "fos_device_request.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

#define REQ "3f9a1c0e5b7d4e2a9c8b6d4f2e0a1b3c"

static void test_ids_apply_once(void)
{
    CHECK(fos_device_request_decide(NULL, NULL) == FOS_DEVICE_REQUEST_NONE, "absent");
    CHECK(fos_device_request_decide("", REQ) == FOS_DEVICE_REQUEST_NONE, "empty");
    CHECK(fos_device_request_decide(REQ, NULL) == FOS_DEVICE_REQUEST_APPLY, "first on a fresh frame");
    CHECK(fos_device_request_decide(REQ, "") == FOS_DEVICE_REQUEST_APPLY, "nothing stored yet");
    CHECK(fos_device_request_decide(REQ, REQ) == FOS_DEVICE_REQUEST_SEEN,
          "the same deploy on the next wake must not apply (or reboot) again");
    CHECK(fos_device_request_decide("another-deploy", REQ) == FOS_DEVICE_REQUEST_APPLY, "a new deploy");
}

static void test_bad_ids_are_refused(void)
{
    CHECK(fos_device_request_decide("has space", NULL) == FOS_DEVICE_REQUEST_INVALID, "space");
    CHECK(fos_device_request_decide("q\"uote", NULL) == FOS_DEVICE_REQUEST_INVALID, "quote");
    char id[FOS_DEVICE_REQUEST_ID_LEN + 1];
    memset(id, 'a', sizeof(id));
    id[FOS_DEVICE_REQUEST_ID_LEN - 1] = '\0';
    CHECK(fos_device_request_decide(id, NULL) == FOS_DEVICE_REQUEST_APPLY, "longest that fits");
    id[FOS_DEVICE_REQUEST_ID_LEN - 1] = 'a';
    id[FOS_DEVICE_REQUEST_ID_LEN] = '\0';
    CHECK(fos_device_request_decide(id, NULL) == FOS_DEVICE_REQUEST_INVALID, "one too long");
}

static void test_console_keys(void)
{
    const char *allowed[] = {"hardware", "panel", "pins", "gpio_buttons", "render_mode", "interval",
                             "deep_sleep_on_battery", "wake_check", "battery_pin", "admin_auth",
                             "assets_sd_pins", "hostname"};
    for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
        CHECK(fos_device_request_console_key_allowed(allowed[i]), "%s should be deployable", allowed[i]);
    }
    /* What connects the frame to its control plane stays console-only. */
    const char *refused[] = {"wifi_ssid", "wifi_pass", "backend", "api_key", "frame_id", "cloud_url",
                             "claim_token", "cloud_wsurl", "ap_psk", "allow_local_network", "", "Panel"};
    for (size_t i = 0; i < sizeof(refused) / sizeof(refused[0]); i++) {
        CHECK(!fos_device_request_console_key_allowed(refused[i]), "%s must not be deployable", refused[i]);
    }
    CHECK(!fos_device_request_console_key_allowed(NULL), "NULL");
}

int main(void)
{
    test_ids_apply_once();
    test_bad_ids_are_refused();
    test_console_keys();
    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
