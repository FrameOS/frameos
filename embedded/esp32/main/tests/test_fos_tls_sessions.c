/*
 * Host tests for the table of TLS sessions a frame can resume
 * (fos_tls_sessions.h, used by frameos_nim_glue.c "TLS sessions resumed").
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      main/tests/test_fos_tls_sessions.c -o /tmp/test_fos_tls_sessions && /tmp/test_fos_tls_sessions
 *
 * (backend/app/tasks/tests/test_esp32_tls_sessions.py does exactly that in CI.)
 */
#include <stdio.h>

#include "fos_tls_sessions.h"

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

#define MINUTE ((int64_t)60 * 1000)

/* Sessions are pointers the table never reads: these stand for them. */
static int s_a, s_b, s_c, s_d, s_e, s_f, s_g, s_h;

static void test_a_key_is_the_host_in_lower_case_and_its_port(void)
{
    char key[FOS_TLS_SESSION_KEY_LEN];
    CHECK(fos_tls_session_key("News.YCombinator.com", 443, key, sizeof(key)));
    CHECK(strcmp(key, "news.ycombinator.com:443") == 0);
    CHECK(fos_tls_session_key("example.com", 8443, key, sizeof(key)));
    CHECK(strcmp(key, "example.com:8443") == 0);
    CHECK(fos_tls_session_key("a", 1, key, sizeof(key)) && strcmp(key, "a:1") == 0);
    CHECK(fos_tls_session_key("example.com", 65535, key, sizeof(key)) && strcmp(key, "example.com:65535") == 0);
    /* No host, no port: nothing to keep a session under. */
    CHECK(!fos_tls_session_key("", 443, key, sizeof(key)));
    CHECK(!fos_tls_session_key(NULL, 443, key, sizeof(key)));
    CHECK(!fos_tls_session_key("example.com", 0, key, sizeof(key)));
    CHECK(!fos_tls_session_key("example.com", 70000, key, sizeof(key)));
    /* A name that does not fit is not cut to one that does: another host
     * could share the cut. */
    char long_host[FOS_TLS_SESSION_KEY_LEN + 8];
    memset(long_host, 'h', sizeof(long_host) - 1);
    long_host[sizeof(long_host) - 1] = '\0';
    CHECK(!fos_tls_session_key(long_host, 443, key, sizeof(key)));
    long_host[FOS_TLS_SESSION_KEY_LEN - 7] = '\0'; /* the longest that fits with ":65535" */
    CHECK(fos_tls_session_key(long_host, 65535, key, sizeof(key)));
    CHECK(strlen(key) == FOS_TLS_SESSION_KEY_LEN - 1);
    long_host[FOS_TLS_SESSION_KEY_LEN - 7] = 'h';
    long_host[FOS_TLS_SESSION_KEY_LEN - 6] = '\0';
    CHECK(!fos_tls_session_key(long_host, 443, key, sizeof(key)));
}

static void test_a_session_is_offered_to_its_own_host_and_port_alone(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    void *stale = &s_f;
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 0, &stale) == NULL);
    CHECK(stale == NULL);
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_a, 1000) == NULL);
    /* Another host, the same host on another port, a name it starts: none. */
    CHECK(fos_tls_sessions_take(&table, "example.org:443", 2000, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, "example.com:8443", 2000, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, "example.com:4", 2000, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, "xample.com:443", 2000, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, "", 2000, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, NULL, 2000, &stale) == NULL);
    CHECK(stale == NULL);
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 2000, &stale) == &s_a);
}

static void test_a_session_taken_is_out_of_the_table_until_put_back(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    void *stale = NULL;
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_a, 0) == NULL);
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 10, &stale) == &s_a);
    /* A second task connecting to the same host meanwhile gets none: two
     * connections never offer one session. */
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 20, &stale) == NULL);
    CHECK(stale == NULL);
    /* Its handshake over, the session it ended with goes in. */
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_b, 30) == NULL);
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 40, &stale) == &s_b);
}

static void test_a_newer_session_takes_the_place_of_the_hosts_older_one(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    void *stale = NULL;
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_a, 0) == NULL);
    /* Two connections to one host ended: the first one's session comes back
     * to be freed, and the host holds one slot, not two. */
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_b, 10) == &s_a);
    CHECK(fos_tls_sessions_put(&table, "b.example:443", &s_c, 20) == NULL);
    CHECK(fos_tls_sessions_put(&table, "c.example:443", &s_d, 30) == NULL);
    CHECK(fos_tls_sessions_put(&table, "d.example:443", &s_e, 40) == NULL);
    CHECK(fos_tls_sessions_put(&table, "e.example:443", &s_f, 41) == NULL);
    CHECK(fos_tls_sessions_put(&table, "f.example:443", &s_g, 42) == NULL);
    /* The table is full with the host in one slot: a seventh host would put
     * the oldest out, not find a second copy to spare. */
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 50, &stale) == &s_b);
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 60, &stale) == NULL);
}

static void test_the_host_used_longest_ago_goes_first(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    void *stale = NULL;
    CHECK(FOS_TLS_SESSION_SLOTS == 6);
    CHECK(fos_tls_sessions_put(&table, "a.example:443", &s_a, 100) == NULL);
    CHECK(fos_tls_sessions_put(&table, "b.example:443", &s_b, 200) == NULL);
    CHECK(fos_tls_sessions_put(&table, "c.example:443", &s_c, 300) == NULL);
    CHECK(fos_tls_sessions_put(&table, "d.example:443", &s_d, 400) == NULL);
    CHECK(fos_tls_sessions_put(&table, "e.example:443", &s_e, 450) == NULL);
    CHECK(fos_tls_sessions_put(&table, "f.example:443", &s_f, 460) == NULL);
    /* a is used again: taken, and put back as of now. */
    CHECK(fos_tls_sessions_take(&table, "a.example:443", 500, &stale) == &s_a);
    CHECK(fos_tls_sessions_put(&table, "a.example:443", &s_a, 600) == NULL);
    /* One host more than it holds: b, used longest ago, is the one let go. */
    CHECK(fos_tls_sessions_put(&table, "g.example:443", &s_g, 700) == &s_b);
    CHECK(fos_tls_sessions_take(&table, "b.example:443", 800, &stale) == NULL);
    /* And then c. */
    CHECK(fos_tls_sessions_put(&table, "h.example:443", &s_h, 750) == &s_c);
    CHECK(fos_tls_sessions_take(&table, "a.example:443", 800, &stale) == &s_a);
    CHECK(fos_tls_sessions_take(&table, "c.example:443", 800, &stale) == NULL);
    CHECK(fos_tls_sessions_take(&table, "d.example:443", 800, &stale) == &s_d);
    CHECK(fos_tls_sessions_take(&table, "e.example:443", 800, &stale) == &s_e);
    CHECK(fos_tls_sessions_take(&table, "f.example:443", 800, &stale) == &s_f);
    CHECK(fos_tls_sessions_take(&table, "g.example:443", 800, &stale) == &s_g);
    CHECK(fos_tls_sessions_take(&table, "h.example:443", 800, &stale) == &s_h);
    CHECK(stale == NULL);
}

static void test_a_session_not_used_for_ten_minutes_is_not_offered(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    void *stale = NULL;
    CHECK(FOS_TLS_SESSION_MAX_AGE_MS == 10 * MINUTE);
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_a, 0) == NULL);
    /* Still good at ten minutes. */
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 10 * MINUTE, &stale) == &s_a);
    CHECK(stale == NULL);
    CHECK(fos_tls_sessions_put(&table, "example.com:443", &s_a, 10 * MINUTE) == NULL);
    /* Past it: handed back to be freed, never offered, and its slot is free. */
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 20 * MINUTE + 1, &stale) == NULL);
    CHECK(stale == &s_a);
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 20 * MINUTE + 2, &stale) == NULL);
    CHECK(stale == NULL);
    /* One too old goes before a free slot is spent, so a table never fills
     * with what cannot be offered. */
    memset(&table, 0, sizeof(table));
    CHECK(fos_tls_sessions_put(&table, "old.example:443", &s_a, 0) == NULL);
    CHECK(fos_tls_sessions_put(&table, "new.example:443", &s_b, 11 * MINUTE) == &s_a);
    CHECK(fos_tls_sessions_take(&table, "old.example:443", 11 * MINUTE, &stale) == NULL);
    CHECK(stale == NULL);
    CHECK(fos_tls_sessions_take(&table, "new.example:443", 11 * MINUTE, &stale) == &s_b);
}

static void test_what_cannot_be_kept_comes_straight_back(void)
{
    fos_tls_sessions_t table;
    memset(&table, 0, sizeof(table));
    char long_key[FOS_TLS_SESSION_KEY_LEN + 4];
    memset(long_key, 'k', sizeof(long_key) - 1);
    long_key[sizeof(long_key) - 1] = '\0';
    /* The caller frees what put() returns: a session with no name to keep it
     * under is that. */
    CHECK(fos_tls_sessions_put(&table, long_key, &s_a, 0) == &s_a);
    CHECK(fos_tls_sessions_put(&table, "", &s_a, 0) == &s_a);
    CHECK(fos_tls_sessions_put(&table, NULL, &s_a, 0) == &s_a);
    CHECK(fos_tls_sessions_put(NULL, "example.com:443", &s_a, 0) == &s_a);
    CHECK(fos_tls_sessions_put(&table, "example.com:443", NULL, 0) == NULL);
    void *stale = NULL;
    CHECK(fos_tls_sessions_take(&table, "example.com:443", 1, &stale) == NULL);
    CHECK(fos_tls_sessions_take(NULL, "example.com:443", 1, &stale) == NULL);
    /* The longest key that fits is kept whole. */
    long_key[FOS_TLS_SESSION_KEY_LEN - 1] = '\0';
    CHECK(fos_tls_sessions_put(&table, long_key, &s_b, 0) == NULL);
    CHECK(fos_tls_sessions_take(&table, long_key, 1, &stale) == &s_b);
}

int main(void)
{
    test_a_key_is_the_host_in_lower_case_and_its_port();
    test_a_session_is_offered_to_its_own_host_and_port_alone();
    test_a_session_taken_is_out_of_the_table_until_put_back();
    test_a_newer_session_takes_the_place_of_the_hosts_older_one();
    test_the_host_used_longest_ago_goes_first();
    test_a_session_not_used_for_ten_minutes_is_not_offered();
    test_what_cannot_be_kept_comes_straight_back();
    printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
