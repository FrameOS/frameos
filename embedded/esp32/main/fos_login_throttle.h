#pragma once
/* How many wrong device logins the frame's HTTP server looks at.
 *
 * The device login is a name and a password its owner chose, sent as HTTP
 * Basic with every request, and nothing stopped a client on the network from
 * trying one after another as fast as the server answers. Ten wrong ones in
 * five minutes (the Pi's rule for its admin login, admin_api_routes.nim), and
 * until those five minutes are over no Basic login is looked at: the answer
 * is 429 whatever the password. Counted for the whole device, not per
 * address: there is no memory for a table of clients, and the credential the
 * control planes use is not this one. A backend's `Authorization: Bearer` key
 * is long and random, is not counted and is never locked out, so a frame's
 * plane keeps working while somebody guesses at its login.
 *
 * Pure, so main/tests/test_fos_login_throttle.c runs it; the caller brings
 * the clock (seconds since boot on the device). */
#include <stdbool.h>
#include <stdint.h>

#define FOS_LOGIN_THROTTLE_WRONG 10
#define FOS_LOGIN_THROTTLE_WINDOW_S 300

typedef struct {
    int64_t window_start_s; /* when the first wrong login of the window came */
    uint32_t wrong;         /* wrong logins since then */
} fos_login_throttle_t;

static inline bool fos_login_window_open(const fos_login_throttle_t *t, int64_t now_s)
{
    return t->wrong > 0 && now_s >= t->window_start_s && now_s - t->window_start_s < FOS_LOGIN_THROTTLE_WINDOW_S;
}

/* No Basic login is looked at now: the window's ten are spent. */
static inline bool fos_login_throttled(const fos_login_throttle_t *t, int64_t now_s)
{
    return fos_login_window_open(t, now_s) && t->wrong >= FOS_LOGIN_THROTTLE_WRONG;
}

/* A Basic login that was looked at and was wrong. */
static inline void fos_login_wrong(fos_login_throttle_t *t, int64_t now_s)
{
    if (!fos_login_window_open(t, now_s)) {
        t->window_start_s = now_s;
        t->wrong = 0;
    }
    t->wrong++;
}
