/* The LAN access code's state machine. See fos_lan_access.h. */
#include "fos_lan_access.h"

#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_attr.h"
#include "freertos/FreeRTOS.h"
/* Started and answered on the cloud task (or the render task, for the
 * backend's queue), read by the render task every second: a spinlock
 * around a few words, statically initialised so there is no init to forget. */
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
#define LAN_LOCK() portENTER_CRITICAL(&s_lock)
#define LAN_UNLOCK() portEXIT_CRITICAL(&s_lock)
/* The budget outlives a `reboot` verb and a deep sleep (RTC memory survives
 * both, not a power cycle): otherwise a control plane could reset it by
 * rebooting the frame, and a battery frame would start fresh every wake. */
#define LAN_BUDGET_ATTR RTC_NOINIT_ATTR
#else
#define LAN_LOCK() ((void)0)
#define LAN_UNLOCK() ((void)0)
#define LAN_BUDGET_ATTR
#endif

static char s_code[FOS_LAN_ACCESS_CODE_LEN + 1];
static bool s_pending = false;
static int64_t s_expires_at = 0;
static uint8_t s_attempts_left = 0;
static uint32_t s_generation = 0;

/* The wrong-code budget. Not initialised at boot (RTC_NOINIT on the device):
 * the magic tells a kept budget from power-on garbage. */
#define LAN_BUDGET_MAGIC 0x4C414E42u /* "LANB" */
typedef struct {
    uint32_t magic;
    uint32_t wrong;      /* wrong codes since window_start */
    int64_t window_start;
} lan_budget_t;
LAN_BUDGET_ATTR static lan_budget_t s_budget;

/* The window as of `now_s`, reset when it has run out. A clock BEHIND the
 * stored start (an SNTP correction backwards; garbage at power-on is caught
 * by the magic) keeps the count and restarts the window from now: every way
 * this misjudges the time errs towards a longer lock-out, never a shorter
 * one. */
static void budget_roll_locked(int64_t now_s)
{
    if (s_budget.magic != LAN_BUDGET_MAGIC || s_budget.wrong > FOS_LAN_ACCESS_BUDGET_WRONG) {
        s_budget.magic = LAN_BUDGET_MAGIC;
        s_budget.wrong = 0;
        s_budget.window_start = now_s;
        return;
    }
    if (now_s < s_budget.window_start) {
        s_budget.window_start = now_s;
    } else if (now_s - s_budget.window_start >= FOS_LAN_ACCESS_BUDGET_WINDOW_SEC) {
        s_budget.wrong = 0;
        s_budget.window_start = now_s;
    }
}

static bool budget_spent_locked(int64_t now_s)
{
    budget_roll_locked(now_s);
    return s_budget.wrong >= FOS_LAN_ACCESS_BUDGET_WRONG;
}

static void budget_note_wrong_locked(int64_t now_s)
{
    budget_roll_locked(now_s);
    /* The window opens at the first wrong code, not at the last reset. */
    if (s_budget.wrong == 0) s_budget.window_start = now_s;
    s_budget.wrong++;
}

static void wipe_locked(void)
{
    /* volatile: the compiler may not drop a store to a buffer it can prove
     * is dead, and a used code has no business lingering in RAM. */
    volatile char *p = s_code;
    for (size_t i = 0; i < sizeof(s_code); i++) p[i] = 0;
    s_pending = false;
    s_expires_at = 0;
    s_attempts_left = 0;
}

static bool live_locked(int64_t now_s)
{
    if (s_pending && now_s >= s_expires_at) wipe_locked();
    return s_pending;
}

void fos_lan_access_mint(fos_lan_access_rng_t rng, char *out)
{
    /* 2^32 - (2^32 mod 10^6): draws at or above it would make the low codes
     * likelier. One draw in ~4300 is rejected; the bound is a fallback for
     * an RNG that never leaves the rejected band (it cannot happen with
     * esp_random(), and a stuck RNG still yields digits, not a hang). */
    const uint64_t limit = 4294967296ull - (4294967296ull % 1000000ull);
    uint32_t value = 0;
    for (int tries = 0; tries < 64; tries++) {
        value = rng();
        if ((uint64_t)value < limit) break;
    }
    value %= 1000000u;
    for (int i = FOS_LAN_ACCESS_CODE_LEN - 1; i >= 0; i--) {
        out[i] = (char)('0' + value % 10u);
        value /= 10u;
    }
    out[FOS_LAN_ACCESS_CODE_LEN] = '\0';
}

uint32_t fos_lan_access_start(int64_t now_s, fos_lan_access_rng_t rng)
{
    char code[FOS_LAN_ACCESS_CODE_LEN + 1];
    fos_lan_access_mint(rng, code); /* outside the lock: rng() may be slow */
    LAN_LOCK();
    if (budget_spent_locked(now_s)) {
        LAN_UNLOCK();
        volatile char *p = code;
        for (size_t i = 0; i < sizeof(code); i++) p[i] = 0;
        return 0;
    }
    memcpy(s_code, code, sizeof(s_code));
    s_pending = true;
    s_expires_at = now_s + FOS_LAN_ACCESS_TTL_SEC;
    s_attempts_left = FOS_LAN_ACCESS_MAX_ATTEMPTS;
    if (++s_generation == 0) s_generation = 1;
    const uint32_t generation = s_generation;
    LAN_UNLOCK();
    volatile char *p = code;
    for (size_t i = 0; i < sizeof(code); i++) p[i] = 0;
    return generation;
}

static bool is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
}

fos_lan_access_result_t fos_lan_access_consume(const char *code, int64_t now_s)
{
    /* Surrounding whitespace is not part of the code (a pasted "123456\n"),
     * the same trim the Pi applies; nothing but whitespace is no code. */
    if (code == NULL) return FOS_LAN_ACCESS_CODE_REQUIRED;
    while (is_space(*code)) code++;
    if (code[0] == '\0') return FOS_LAN_ACCESS_CODE_REQUIRED;
    /* Length is not the secret (it is always six); bounded so a long string
     * costs nothing — anything past the bound is simply not the code. */
    size_t given = 0;
    while (given < 64 && code[given] != '\0') given++;
    if (code[given] != '\0') {
        given = FOS_LAN_ACCESS_CODE_LEN + 1;
    } else {
        while (given > 0 && is_space(code[given - 1])) given--;
    }
    fos_lan_access_result_t result;
    LAN_LOCK();
    if (budget_spent_locked(now_s)) {
        result = FOS_LAN_ACCESS_RATE_LIMITED; /* before the challenge is even looked at */
    } else if (!live_locked(now_s)) {
        result = FOS_LAN_ACCESS_CODE_EXPIRED;
    } else {
        /* Constant time over the six digits: every byte is looked at
         * whatever the first mismatch, so the time a wrong code takes says
         * nothing about how much of it was right. */
        unsigned diff = given == FOS_LAN_ACCESS_CODE_LEN ? 0u : 1u;
        for (size_t i = 0; i < FOS_LAN_ACCESS_CODE_LEN; i++) {
            const char c = i < given ? code[i] : 0;
            diff |= (unsigned)(unsigned char)(c ^ s_code[i]);
        }
        if (diff == 0) {
            wipe_locked();
            result = FOS_LAN_ACCESS_OK;
        } else {
            budget_note_wrong_locked(now_s);
            if (--s_attempts_left == 0) {
                wipe_locked();
                result = FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS;
            } else {
                result = FOS_LAN_ACCESS_INVALID_CODE;
            }
        }
    }
    LAN_UNLOCK();
    return result;
}

void fos_lan_access_clear(void)
{
    LAN_LOCK();
    wipe_locked();
    LAN_UNLOCK();
}

bool fos_lan_access_rate_limited(int64_t now_s)
{
    LAN_LOCK();
    const bool spent = budget_spent_locked(now_s);
    LAN_UNLOCK();
    return spent;
}

uint32_t fos_lan_access_panel_code(int64_t now_s, char *code_out)
{
    uint32_t generation = 0;
    LAN_LOCK();
    if (live_locked(now_s)) {
        generation = s_generation;
        if (code_out != NULL) memcpy(code_out, s_code, sizeof(s_code));
    }
    LAN_UNLOCK();
    if (generation == 0 && code_out != NULL) code_out[0] = '\0';
    return generation;
}

uint32_t fos_lan_access_seconds_left(int64_t now_s)
{
    uint32_t left = 0;
    LAN_LOCK();
    if (live_locked(now_s)) left = (uint32_t)(s_expires_at - now_s);
    LAN_UNLOCK();
    return left;
}

const char *fos_lan_access_result_token(fos_lan_access_result_t result)
{
    switch (result) {
        case FOS_LAN_ACCESS_OK: return NULL;
        case FOS_LAN_ACCESS_CODE_REQUIRED: return "code_required";
        case FOS_LAN_ACCESS_CODE_EXPIRED: return "code_expired";
        case FOS_LAN_ACCESS_INVALID_CODE: return "invalid_code";
        case FOS_LAN_ACCESS_TOO_MANY_ATTEMPTS: return "too_many_attempts";
        case FOS_LAN_ACCESS_RATE_LIMITED: return "rate_limited";
    }
    return "invalid_code";
}
