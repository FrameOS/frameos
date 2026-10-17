/*
 * The LAN access code: turning the frame's LAN access switch on from a
 * control plane takes a code the frame shows on its panel (docs/lan-access.md).
 *
 * `lan_access_challenge` mints six digits, the render task draws them over
 * the next render for the panel only (fos_client.c), and `lan_access_set
 * {enabled: true, code}` must give them back. Single use, 300 s, five tries,
 * compared in constant time, and at most ten wrong codes an hour across
 * challenges (`rate_limited` once spent). The code never leaves this module except into
 * fos_lan_access_panel_code(), whose one caller draws it: it is not in an
 * ack, a log line or an image the frame serves.
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
 * this a control plane could mint code after code and keep guessing; with it,
 * ten guesses an hour. A right code does not reset the window. */
#define FOS_LAN_ACCESS_BUDGET_WRONG 10
#define FOS_LAN_ACCESS_BUDGET_WINDOW_SEC 3600

/* A uniform 32-bit random value: esp_random() on the device. */
typedef uint32_t (*fos_lan_access_rng_t)(void);

/* The clock every caller on the device passes as `now_s`: system time, which
 * the RTC keeps through deep sleep and software resets (only a power-on
 * starts it again), so the wrong-code budget below does not refill with
 * every reboot or every wake of a battery frame — esp_timer starts at 0 each
 * boot. The Pi keeps its TTL in wall-clock time too. */
static inline int64_t fos_lan_access_now(void)
{
    return (int64_t)time(NULL);
}

typedef enum {
    FOS_LAN_ACCESS_OK = 0,
    FOS_LAN_ACCESS_CODE_REQUIRED,    /* no code given (nothing is spent) */
    FOS_LAN_ACCESS_CODE_EXPIRED,     /* no challenge pending, or it ran out */
    FOS_LAN_ACCESS_INVALID_CODE,     /* wrong: one attempt spent */
    FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS, /* the last attempt was wrong: challenge gone */
    FOS_LAN_ACCESS_RATE_LIMITED      /* the wrong-code budget is spent: nothing touched */
} fos_lan_access_result_t;

/* Start a challenge at `now_s` (fos_lan_access_now()), replacing any pending
 * one. Returns its generation, never 0 — or 0 when the wrong-code budget is
 * spent (`rate_limited`), leaving any pending challenge as it was. */
uint32_t fos_lan_access_start(int64_t now_s, fos_lan_access_rng_t rng);

/* Check `code` (NULL or "" = none given, `code_required`). With the budget
 * spent, `rate_limited` before anything else is looked at. OK clears the
 * challenge, so does the wrong code that spends the last attempt; every
 * wrong code counts against the budget. */
fos_lan_access_result_t fos_lan_access_consume(const char *code, int64_t now_s);

/* Drop any pending challenge (LAN access turned off: the code has nothing
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
