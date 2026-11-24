/* Host test of fos_login_throttle.h, the cap on wrong device logins the
 * ESP32's HTTP server looks at. Pure C, no IDF:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/tests/test_fos_login_throttle.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_http_gate.py.
 */
#include <stdio.h>

#include "fos_login_throttle.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond) do { \
        checks++; \
        if (!(cond)) { \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            failures++; \
        } \
    } while (0)

int main(void)
{
    fos_login_throttle_t t = {0};
    /* Nothing wrong yet, at boot (second 0) or later. */
    CHECK(!fos_login_throttled(&t, 0) && !fos_login_throttled(&t, 100000));

    /* Nine wrong logins are nine looked at; the tenth closes the window. */
    for (int i = 0; i < FOS_LOGIN_THROTTLE_WRONG - 1; i++) {
        fos_login_wrong(&t, 1000 + i);
        CHECK(!fos_login_throttled(&t, 1000 + i));
    }
    fos_login_wrong(&t, 1010);
    CHECK(fos_login_throttled(&t, 1010));
    /* Until five minutes after the FIRST wrong one, not the last. */
    CHECK(fos_login_throttled(&t, 1000 + FOS_LOGIN_THROTTLE_WINDOW_S - 1));
    CHECK(!fos_login_throttled(&t, 1000 + FOS_LOGIN_THROTTLE_WINDOW_S));

    /* The next wrong login opens a new window with ten of its own. */
    fos_login_wrong(&t, 2000);
    CHECK(t.wrong == 1 && t.window_start_s == 2000 && !fos_login_throttled(&t, 2000));

    /* A few wrong ones, then quiet: the count does not carry over. */
    fos_login_throttle_t slow = {0};
    for (int i = 0; i < 5; i++) fos_login_wrong(&slow, 10 + i);
    for (int i = 0; i < 9; i++) fos_login_wrong(&slow, 10 + FOS_LOGIN_THROTTLE_WINDOW_S + i);
    CHECK(slow.wrong == 9 && !fos_login_throttled(&slow, 10 + FOS_LOGIN_THROTTLE_WINDOW_S + 9));

    /* A window that begins at second 0 (the first request after boot). */
    fos_login_throttle_t boot = {0};
    for (int i = 0; i < FOS_LOGIN_THROTTLE_WRONG; i++) fos_login_wrong(&boot, 0);
    CHECK(fos_login_throttled(&boot, 0) && fos_login_throttled(&boot, FOS_LOGIN_THROTTLE_WINDOW_S - 1));
    CHECK(!fos_login_throttled(&boot, FOS_LOGIN_THROTTLE_WINDOW_S));

    /* A clock that went back (it cannot on the device: seconds since boot)
     * never keeps the lock: the window is simply over. */
    CHECK(!fos_login_throttled(&t, 5));

    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
