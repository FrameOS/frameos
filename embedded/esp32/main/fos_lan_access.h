/*
 * The local network access code: turning the frame's local network access switch on from a
 * control plane takes a code the frame shows on its panel (docs/lan-access.md).
 *
 * `lan_access_challenge` mints six digits, the render task draws them over
 * the next render for the panel only (fos_client.c), and `lan_access_set
 * {enabled: true, code}` must give them back. Single use, 300 s, five tries,
 * compared in constant time, and at most ten wrong codes a window across
 * challenges (`rate_limited` once spent): the first window is an hour, and
 * each one that saw a wrong code makes the next twice as long. The code never leaves this module except into
 * fos_lan_access_panel_code(), whose one caller draws it: it is not in an
 * ack, a log line or an image the frame serves.
 *
 * The same ceremony adopts the frame by a backend (docs/scene-settings.md
 * "Linking the frame"): a code minted for the `adopt` scope is drawn as the
 * "Adoption code" and only POST /api/adopt (fos_http.c) takes it. A code is
 * good for the scope it was shown for alone, and the budget is shared.
 *
 * Plain C with no IDF beyond a spinlock, so main/tests/test_fos_lan_access.c
 * runs the whole state machine on a laptop: the clock and the RNG are the
 * caller's (esp_timer seconds and esp_random() on the device).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FOS_LAN_ACCESS_CODE_LEN 6
/* Long enough for a slow e-ink refresh (a 13.3" Spectra panel takes half a
 * minute) and the walk to the frame; the Pi uses the same. */
#define FOS_LAN_ACCESS_TTL_SEC 300
#define FOS_LAN_ACCESS_MAX_ATTEMPTS 5
/* Across challenges: at most this many wrong codes per window, counted from
 * the first wrong one. A new challenge brings five fresh attempts, so without
 * this a control plane could mint code after code and keep guessing. A right
 * code does not reset the window.
 *
 * The window grows. Ten guesses an hour for ever were 87,600 a year at a
 * six-digit code: one frame in twelve, for a control plane that only keeps
 * asking. So every window that saw a wrong code makes the next one twice as
 * long (an hour, two, four ... FOS_LAN_ACCESS_BUDGET_MAX_DOUBLINGS times:
 * 128 hours), and it is an hour again once FOS_LAN_ACCESS_BUDGET_QUIET_SEC
 * have passed without a wrong code. Somebody who mistypes now and then never
 * meets it: a window still takes ten wrong codes. Whoever guesses on gets
 * about 740 a year, one frame in 1,350. The Pi's rule is the same
 * (frameos/src/frameos/local_access.nim). */
#define FOS_LAN_ACCESS_BUDGET_WRONG 10
#define FOS_LAN_ACCESS_BUDGET_WINDOW_SEC 3600
#define FOS_LAN_ACCESS_BUDGET_MAX_DOUBLINGS 7
#define FOS_LAN_ACCESS_BUDGET_QUIET_SEC (30 * 24 * 3600)

/* A uniform 32-bit random value: esp_random() on the device. */
typedef uint32_t (*fos_lan_access_rng_t)(void);

/* The clock every caller on the device passes as `now_s`: seconds the RTC
 * has counted since power-on. It runs through deep sleep and software resets
 * (only a power-on starts it again, and that clears the budget's memory too),
 * so the wrong-code budget below does not refill with every reboot or every
 * wake of a battery frame, as it would by esp_timer, which starts at 0 each
 * boot. Not the system time: SNTP sets that, unauthenticated, and whoever
 * answers for the time server could step the frame's clock past a lock-out.
 * (The Pi keeps its budget in a file, by wall clock.) */
#ifdef ESP_PLATFORM
#include "esp_rtc_time.h"
static inline int64_t fos_lan_access_now(void)
{
    return (int64_t)(esp_rtc_get_time_us() / 1000000ULL);
}
#else
static inline int64_t fos_lan_access_now(void)
{
    return (int64_t)time(NULL);
}
#endif

typedef enum {
    FOS_LAN_ACCESS_OK = 0,
    FOS_LAN_ACCESS_CODE_REQUIRED,    /* no code given (nothing is spent) */
    FOS_LAN_ACCESS_CODE_EXPIRED,     /* no challenge pending, or it ran out */
    FOS_LAN_ACCESS_INVALID_CODE,     /* wrong: one attempt spent */
    FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS, /* the last attempt was wrong: challenge gone */
    FOS_LAN_ACCESS_RATE_LIMITED      /* the wrong-code budget is spent: nothing touched */
} fos_lan_access_result_t;

/* What a code unlocks: the local network access switch (the cloud's
 * `lan_access_set`), or adoption by a backend (POST /api/adopt). */
typedef enum {
    FOS_LAN_ACCESS_SCOPE_LAN = 0,
    FOS_LAN_ACCESS_SCOPE_ADOPT,
    FOS_LAN_ACCESS_SCOPE_NONE /* fos_lan_access_scope(): nothing pending */
} fos_lan_access_scope_t;

/* Start a challenge for `scope` at `now_s` (fos_lan_access_now()), replacing
 * any pending one. Returns its generation, never 0 — or 0 when the wrong-code
 * budget is spent (`rate_limited`), leaving any pending challenge as it was. */
uint32_t fos_lan_access_start(int64_t now_s, fos_lan_access_rng_t rng, fos_lan_access_scope_t scope);

/* Check `code` (NULL or "" = none given, `code_required`) for `scope`. With
 * the budget spent, `rate_limited` before anything else is looked at. A code
 * pending for another scope is `code_expired` and costs no attempt: there is
 * no code for this scope to guess (the Pi's consumeLocalAccessCode). OK
 * clears the challenge, so does the wrong code that spends the last attempt;
 * every wrong code counts against the budget. */
fos_lan_access_result_t fos_lan_access_consume(const char *code, int64_t now_s, fos_lan_access_scope_t scope);

/* The scope of the challenge pending at `now_s`, FOS_LAN_ACCESS_SCOPE_NONE
 * when there is none. */
fos_lan_access_scope_t fos_lan_access_scope(int64_t now_s);

/* Drop any pending challenge (local network access turned off: the code has nothing
 * left to do). The panel repaints because fos_lan_access_panel_code() now
 * answers 0. The budget is untouched. */
void fos_lan_access_clear(void);

/* Is the wrong-code budget spent at `now_s`? */
bool fos_lan_access_rate_limited(int64_t now_s);

/* The challenge the panel should show right now: its generation and, when
 * `code_out` is not NULL, its digits (FOS_LAN_ACCESS_CODE_LEN + 1 bytes).
 * 0 when there is none — never started, answered, out of attempts or
 * expired. A new generation per challenge is what tells the render task the
 * panel needs a repaint. */
uint32_t fos_lan_access_panel_code(int64_t now_s, char *code_out);

/* Seconds until the pending challenge expires, 0 when there is none. */
uint32_t fos_lan_access_seconds_left(int64_t now_s);

/* The ack token of a refusal (docs/cloud-frames-contract.json errors
 * `lan_access_set`, and `rate_limited` for `lan_access_challenge` too);
 * NULL for OK. */
const char *fos_lan_access_result_token(fos_lan_access_result_t result);

/* Mint six uniform digits into `out` (FOS_LAN_ACCESS_CODE_LEN + 1 bytes):
 * a 32-bit draw is kept only below the largest multiple of 10^6, so every
 * code is equally likely. Exposed for the host test. */
void fos_lan_access_mint(fos_lan_access_rng_t rng, char *out);

#ifdef __cplusplus
}
#endif
