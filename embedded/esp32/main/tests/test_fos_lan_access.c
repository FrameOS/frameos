/*
 * Host tests for the local network access code (fos_lan_access.c): the state machine
 * behind `lan_access_challenge` / `lan_access_set` (docs/lan-access.md). The
 * clock and the RNG are injected, so expiry, attempts and the rejection
 * sampling are all driven from here.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_lan_access.c main/tests/test_fos_lan_access.c \
 *      -o /tmp/test_fos_lan_access && /tmp/test_fos_lan_access
 */
#include <stdio.h>
#include <string.h>

#include "fos_lan_access.h"

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

/* A scripted RNG: hands out `s_script` in order, then repeats the last. */
static const uint32_t *s_script = NULL;
static size_t s_script_len = 0;
static size_t s_script_pos = 0;
static size_t s_draws = 0;

static uint32_t scripted_rng(void)
{
    s_draws++;
    if (s_script_len == 0) return 0;
    uint32_t value = s_script[s_script_pos < s_script_len ? s_script_pos : s_script_len - 1];
    if (s_script_pos < s_script_len) s_script_pos++;
    return value;
}

static void script(const uint32_t *values, size_t len)
{
    s_script = values;
    s_script_len = len;
    s_script_pos = 0;
    s_draws = 0;
}

static uint32_t s_lcg = 12345u;
static uint32_t lcg_rng(void)
{
    s_lcg = s_lcg * 1664525u + 1013904223u;
    return s_lcg;
}

/* Start a challenge whose code is `value` % 10^6. */
static uint32_t start_with(uint32_t value, int64_t now)
{
    static uint32_t one[1];
    one[0] = value;
    script(one, 1);
    return fos_lan_access_start(now, scripted_rng);
}

static void test_mint_is_six_digits_and_rejects_the_biased_band(void)
{
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];

    static const uint32_t zero[] = {0};
    script(zero, 1);
    fos_lan_access_mint(scripted_rng, code);
    CHECK(strcmp(code, "000000") == 0, "leading zeros kept: %s", code);

    static const uint32_t plain[] = {123456};
    script(plain, 1);
    fos_lan_access_mint(scripted_rng, code);
    CHECK(strcmp(code, "123456") == 0, "code %s", code);

    static const uint32_t big[] = {4293999999u}; /* the last value below the limit */
    script(big, 1);
    fos_lan_access_mint(scripted_rng, code);
    CHECK(strcmp(code, "999999") == 0 && s_draws == 1, "code %s after %zu draws", code, s_draws);

    /* 4294000000 and up is the band that would favour 000000..967295: drawn
     * again, not folded. */
    static const uint32_t biased[] = {4294000000u, 0xFFFFFFFFu, 42u};
    script(biased, 3);
    fos_lan_access_mint(scripted_rng, code);
    CHECK(strcmp(code, "000042") == 0 && s_draws == 3, "code %s after %zu draws", code, s_draws);

    /* An RNG stuck in the band still ends, with digits. */
    static const uint32_t stuck[] = {0xFFFFFFFFu};
    script(stuck, 1);
    fos_lan_access_mint(scripted_rng, code);
    CHECK(strlen(code) == FOS_LAN_ACCESS_CODE_LEN && s_draws == 64, "stuck: %s, %zu draws", code,
          s_draws);
    for (size_t i = 0; i < FOS_LAN_ACCESS_CODE_LEN; i++) {
        CHECK(code[i] >= '0' && code[i] <= '9', "stuck: digit %zu is %c", i, code[i]);
    }

    /* Every position takes every digit, roughly evenly, from a decent RNG. */
    unsigned counts[FOS_LAN_ACCESS_CODE_LEN][10];
    memset(counts, 0, sizeof(counts));
    const unsigned draws = 20000;
    for (unsigned n = 0; n < draws; n++) {
        fos_lan_access_mint(lcg_rng, code);
        for (size_t i = 0; i < FOS_LAN_ACCESS_CODE_LEN; i++) counts[i][code[i] - '0']++;
    }
    for (size_t i = 0; i < FOS_LAN_ACCESS_CODE_LEN; i++) {
        for (int d = 0; d < 10; d++) {
            CHECK(counts[i][d] > draws / 10 * 8 / 10 && counts[i][d] < draws / 10 * 12 / 10,
                  "position %zu digit %d drawn %u times of %u", i, d, counts[i][d], draws);
        }
    }
}

static void test_right_code_once(void)
{
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    uint32_t gen = start_with(654321, 10000);
    CHECK(gen != 0, "generation is never 0");
    CHECK(fos_lan_access_panel_code(10000, code) == gen, "the panel shows this challenge");
    CHECK(strcmp(code, "654321") == 0, "panel code %s", code);
    CHECK(fos_lan_access_seconds_left(10000) == FOS_LAN_ACCESS_TTL_SEC, "left %u",
          fos_lan_access_seconds_left(10000));
    CHECK(fos_lan_access_seconds_left(10100) == FOS_LAN_ACCESS_TTL_SEC - 100, "left %u",
          fos_lan_access_seconds_left(10100));

    CHECK(fos_lan_access_consume("654321", 10100) == FOS_LAN_ACCESS_OK, "the right code");
    CHECK(fos_lan_access_panel_code(10100, code) == 0 && code[0] == '\0',
          "answered: nothing on the panel");
    CHECK(fos_lan_access_seconds_left(10100) == 0, "answered: nothing pending");
    CHECK(fos_lan_access_consume("654321", 10101) == FOS_LAN_ACCESS_CODE_EXPIRED,
          "single use");
}

static void test_missing_code_spends_nothing(void)
{
    start_with(111111, 20000);
    for (int i = 0; i < FOS_LAN_ACCESS_MAX_ATTEMPTS + 2; i++) {
        CHECK(fos_lan_access_consume(NULL, 20000) == FOS_LAN_ACCESS_CODE_REQUIRED, "NULL");
        CHECK(fos_lan_access_consume("", 20000) == FOS_LAN_ACCESS_CODE_REQUIRED, "empty");
    }
    CHECK(fos_lan_access_consume("111111", 20001) == FOS_LAN_ACCESS_OK,
          "no attempt was spent on a missing code");
    CHECK(fos_lan_access_consume(NULL, 20002) == FOS_LAN_ACCESS_CODE_REQUIRED,
          "a missing code is code_required even with nothing pending");
}

static void test_five_attempts(void)
{
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    uint32_t gen = start_with(222222, 30000);
    for (int i = 1; i < FOS_LAN_ACCESS_MAX_ATTEMPTS; i++) {
        CHECK(fos_lan_access_consume("222223", 30000 + i) == FOS_LAN_ACCESS_INVALID_CODE,
              "wrong attempt %d", i);
        CHECK(fos_lan_access_panel_code(30000 + i, code) == gen, "still showing after %d", i);
    }
    CHECK(fos_lan_access_consume("000000", 30010) == FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS,
          "the fifth wrong code");
    CHECK(fos_lan_access_panel_code(30010, NULL) == 0, "cleared: the panel repaints");
    CHECK(fos_lan_access_consume("222222", 30011) == FOS_LAN_ACCESS_CODE_EXPIRED,
          "even the right code is too late now");

    /* The right code on the last attempt still counts. */
    start_with(333333, 30100);
    for (int i = 1; i < FOS_LAN_ACCESS_MAX_ATTEMPTS; i++) {
        fos_lan_access_consume("1", 30100);
    }
    CHECK(fos_lan_access_consume("333333", 30100) == FOS_LAN_ACCESS_OK, "fifth try right");
}

static void test_wrong_shapes_are_wrong_codes(void)
{
    start_with(444444, 40000);
    CHECK(fos_lan_access_consume("44444", 40000) == FOS_LAN_ACCESS_INVALID_CODE, "short");
    CHECK(fos_lan_access_consume("4444444", 40000) == FOS_LAN_ACCESS_INVALID_CODE, "long");
    CHECK(fos_lan_access_consume("44444a", 40000) == FOS_LAN_ACCESS_INVALID_CODE, "letter");
    CHECK(fos_lan_access_consume("444 444", 40000) == FOS_LAN_ACCESS_INVALID_CODE,
          "an inner space is part of what was typed");
    CHECK(fos_lan_access_consume("444444", 40000) == FOS_LAN_ACCESS_OK, "fifth try right");

    /* The control planes strip spaces before the code reaches the device;
     * what still carries one is not the code. */
    start_with(454545, 40100);
    CHECK(fos_lan_access_consume(" 454545", 40100) == FOS_LAN_ACCESS_INVALID_CODE, "padded");
    CHECK(fos_lan_access_consume("454545", 40100) == FOS_LAN_ACCESS_OK, "exact");
    start_with(464646, 40200);
    CHECK(fos_lan_access_consume("464646", 40200) == FOS_LAN_ACCESS_OK, "exact again");
    start_with(474747, 40300);
    char long_code[200];
    memset(long_code, '4', sizeof(long_code) - 1);
    long_code[sizeof(long_code) - 1] = '\0';
    CHECK(fos_lan_access_consume(long_code, 40300) == FOS_LAN_ACCESS_INVALID_CODE, "very long");
    CHECK(fos_lan_access_consume("474747          x", 40300) == FOS_LAN_ACCESS_INVALID_CODE,
          "trailing garbage");
    CHECK(fos_lan_access_consume("474747", 40300) == FOS_LAN_ACCESS_OK, "then right");
}

static void test_expiry(void)
{
    uint32_t gen = start_with(555555, 50000);
    const int64_t last = 50000 + FOS_LAN_ACCESS_TTL_SEC - 1;
    CHECK(fos_lan_access_panel_code(last, NULL) == gen, "alive at %lld", (long long)last);
    CHECK(fos_lan_access_seconds_left(last) == 1, "one second left");
    CHECK(fos_lan_access_panel_code(last + 1, NULL) == 0, "gone at the TTL");
    CHECK(fos_lan_access_seconds_left(last + 1) == 0, "nothing left");
    CHECK(fos_lan_access_consume("555555", last + 1) == FOS_LAN_ACCESS_CODE_EXPIRED,
          "the right code after expiry");

    /* Expiry seen first by consume, not by the panel. */
    start_with(565656, 60000);
    CHECK(fos_lan_access_consume("565656", 60000 + FOS_LAN_ACCESS_TTL_SEC) ==
              FOS_LAN_ACCESS_CODE_EXPIRED, "expired at consume");
    CHECK(fos_lan_access_panel_code(60000, NULL) == 0,
          "an expired challenge is gone, not revived by an earlier clock");
}

static void test_new_challenge_replaces(void)
{
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    uint32_t first = start_with(777777, 70000);
    fos_lan_access_consume("000001", 70000);
    uint32_t second = start_with(888888, 70010);
    CHECK(second != first, "a new generation: the panel repaints");
    CHECK(fos_lan_access_panel_code(70010, code) == second && strcmp(code, "888888") == 0,
          "panel shows %s", code);
    CHECK(fos_lan_access_consume("777777", 70011) == FOS_LAN_ACCESS_INVALID_CODE,
          "the old code is dead");
    /* Fresh attempts and a fresh TTL. */
    for (int i = 2; i < FOS_LAN_ACCESS_MAX_ATTEMPTS; i++) fos_lan_access_consume("1", 70012);
    CHECK(fos_lan_access_seconds_left(70010 + FOS_LAN_ACCESS_TTL_SEC - 5) == 5, "fresh TTL");
    CHECK(fos_lan_access_consume("888888", 70020) == FOS_LAN_ACCESS_OK, "fresh attempts");
}

static void test_tokens(void)
{
    CHECK(fos_lan_access_result_token(FOS_LAN_ACCESS_OK) == NULL, "ok has no token");
    CHECK(strcmp(fos_lan_access_result_token(FOS_LAN_ACCESS_CODE_REQUIRED), "code_required") == 0,
          "code_required");
    CHECK(strcmp(fos_lan_access_result_token(FOS_LAN_ACCESS_CODE_EXPIRED), "code_expired") == 0,
          "code_expired");
    CHECK(strcmp(fos_lan_access_result_token(FOS_LAN_ACCESS_INVALID_CODE), "invalid_code") == 0,
          "invalid_code");
    CHECK(strcmp(fos_lan_access_result_token(FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS),
                 "too_many_attempts") == 0, "too_many_attempts");
    CHECK(strcmp(fos_lan_access_result_token(FOS_LAN_ACCESS_RATE_LIMITED), "rate_limited") == 0,
          "rate_limited");
}

/* Ten wrong codes in a window of an hour, across challenges. Each test
 * before this one ran in its own hour, so the budget starts full. */
static void test_wrong_code_budget(void)
{
    const int64_t t0 = 100000;
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    CHECK(!fos_lan_access_rate_limited(t0), "starts with the budget unspent");

    /* Two challenges' worth of wrong codes: 5 + 4, then a right one. */
    start_with(121212, t0);
    for (int i = 0; i < FOS_LAN_ACCESS_MAX_ATTEMPTS; i++) fos_lan_access_consume("000000", t0 + 1);
    start_with(131313, t0 + 10);
    for (int i = 0; i < 4; i++) {
        CHECK(fos_lan_access_consume("000000", t0 + 11) == FOS_LAN_ACCESS_INVALID_CODE,
              "wrong %d of the second challenge", i + 1);
    }
    CHECK(!fos_lan_access_rate_limited(t0 + 11), "nine wrong: one left");
    CHECK(fos_lan_access_consume("131313", t0 + 12) == FOS_LAN_ACCESS_OK,
          "a right code still works");
    CHECK(!fos_lan_access_rate_limited(t0 + 12), "and does not spend the budget");

    /* The tenth wrong code is answered as what it is; the budget is spent
     * after it. */
    uint32_t gen = start_with(141414, t0 + 20);
    CHECK(gen != 0, "a challenge with one wrong code left");
    CHECK(fos_lan_access_consume("000000", t0 + 21) == FOS_LAN_ACCESS_INVALID_CODE,
          "the tenth wrong code");
    CHECK(fos_lan_access_rate_limited(t0 + 21), "spent after ten");

    /* Spent: refused before the pending challenge is looked at, so it is
     * neither answered nor expired nor replaced. */
    CHECK(fos_lan_access_consume("141414", t0 + 22) == FOS_LAN_ACCESS_RATE_LIMITED,
          "even the right code");
    CHECK(fos_lan_access_consume("999999", t0 + 22) == FOS_LAN_ACCESS_RATE_LIMITED,
          "a wrong code");
    CHECK(fos_lan_access_consume(NULL, t0 + 22) == FOS_LAN_ACCESS_CODE_REQUIRED,
          "no code is still code_required");
    CHECK(fos_lan_access_start(t0 + 23, lcg_rng) == 0, "no new challenge either");
    CHECK(fos_lan_access_panel_code(t0 + 23, code) == gen && strcmp(code, "141414") == 0,
          "the pending challenge is untouched: %s", code);
    CHECK(fos_lan_access_consume("141414", t0 + FOS_LAN_ACCESS_TTL_SEC + 30) ==
              FOS_LAN_ACCESS_RATE_LIMITED, "an expired challenge is not even looked at");

    /* The window runs from the first wrong code (t0 + 1). */
    const int64_t refill = t0 + 1 + FOS_LAN_ACCESS_BUDGET_WINDOW_SEC;
    CHECK(fos_lan_access_rate_limited(refill - 1), "still spent a second before the hour");
    CHECK(fos_lan_access_start(refill - 1, lcg_rng) == 0, "still no challenge");
    CHECK(!fos_lan_access_rate_limited(refill), "refilled an hour after the first wrong code");
    gen = start_with(151515, refill);
    CHECK(gen != 0, "challenges again");
    CHECK(fos_lan_access_consume("000000", refill + 1) == FOS_LAN_ACCESS_INVALID_CODE,
          "a wrong code opens a new window");
    CHECK(fos_lan_access_consume("151515", refill + 2) == FOS_LAN_ACCESS_OK, "and the right one");

    /* A new window opens at its first wrong code: nine more wrong, an hour
     * minus a second after it, still leaves one. */
    const int64_t t1 = refill + 1;
    for (int round = 0; round < 3; round++) {
        start_with(161616, t1 + 100 + round);
        for (int i = 0; i < 3; i++) fos_lan_access_consume("000000", t1 + 100 + round);
    }
    CHECK(fos_lan_access_rate_limited(t1 + 100), "1 + 9 wrong: spent");
    CHECK(!fos_lan_access_rate_limited(t1 + FOS_LAN_ACCESS_BUDGET_WINDOW_SEC),
          "refilled an hour after this window's first wrong code");

    /* A clock that goes backwards (an SNTP correction) keeps the count and
     * restarts the window: longer, never shorter. */
    const int64_t t2 = t1 + 10 * FOS_LAN_ACCESS_BUDGET_WINDOW_SEC;
    for (int round = 0; round < 2; round++) {
        start_with(171717, t2);
        for (int i = 0; i < FOS_LAN_ACCESS_MAX_ATTEMPTS; i++) fos_lan_access_consume("000000", t2);
    }
    CHECK(fos_lan_access_rate_limited(t2), "spent at t2");
    CHECK(fos_lan_access_rate_limited(t2 - 500), "a clock 500 s behind: still spent");
    CHECK(fos_lan_access_rate_limited(t2 - 500 + FOS_LAN_ACCESS_BUDGET_WINDOW_SEC - 1),
          "and the hour counts from the earlier clock");
    CHECK(!fos_lan_access_rate_limited(t2 - 500 + FOS_LAN_ACCESS_BUDGET_WINDOW_SEC),
          "refilled an hour after that");
}

static void test_clear(void)
{
    const int64_t t0 = 200000;
    uint32_t gen = start_with(181818, t0);
    CHECK(fos_lan_access_panel_code(t0, NULL) == gen, "showing");
    fos_lan_access_clear();
    CHECK(fos_lan_access_panel_code(t0, NULL) == 0, "cleared: the panel repaints");
    CHECK(fos_lan_access_seconds_left(t0) == 0, "nothing holds the sleep");
    CHECK(fos_lan_access_consume("181818", t0 + 1) == FOS_LAN_ACCESS_CODE_EXPIRED,
          "the cleared code is dead");
    fos_lan_access_clear(); /* nothing pending: harmless */
    CHECK(fos_lan_access_panel_code(t0 + 2, NULL) == 0, "still nothing");
    uint32_t next = start_with(191919, t0 + 3);
    CHECK(next != 0 && next != gen, "a new challenge after a clear is a new generation");
}

int main(void)
{
    CHECK(fos_lan_access_panel_code(0, NULL) == 0, "nothing pending at boot");
    CHECK(fos_lan_access_consume("123456", 0) == FOS_LAN_ACCESS_CODE_EXPIRED,
          "no challenge: code_expired");
    test_mint_is_six_digits_and_rejects_the_biased_band();
    test_right_code_once();
    test_missing_code_spends_nothing();
    test_five_attempts();
    test_wrong_shapes_are_wrong_codes();
    test_expiry();
    test_new_challenge_replaces();
    test_tokens();
    test_wrong_code_budget();
    test_clear();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
