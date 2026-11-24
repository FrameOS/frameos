/*
 * The TLS sessions a frame can resume (frameos_nim_glue.c, "TLS sessions
 * resumed"): the last few hosts a scene made an HTTPS request to, each with
 * the session its handshake ended with.
 *
 * A full handshake with a host whose certificates are signed with P-384 (Let's
 * Encrypt's ECDSA chain: Hacker News, Wikipedia; GlobalSign's: CNN, the BBC)
 * is two to three seconds of an ESP32-S3, which verifies them in software; a
 * session resumed (RFC 5077: the server's ticket, sent back) skips the chain
 * and the key exchange. So the session of a host is kept when a connection to
 * it closes, and offered at the next one.
 *
 * - A session is kept under "host:port" and offered to that host and port
 *   alone: the name is compared whole, never by a hash.
 * - It is taken out of the table while a connection offers it, so two tasks
 *   never hold one session, and put back (or the newer one the server gave)
 *   when the handshake is over. One that failed is not put back, and neither
 *   is the session of a server that did not take the one it was offered
 *   (GitHub, DuckDuckGo): it would hold a slot for nothing.
 * - FOS_TLS_SESSION_SLOTS hosts; the one used longest ago goes first. One not
 *   used for FOS_TLS_SESSION_MAX_AGE_MS is let go when its host is next asked
 *   for or the table is next written.
 *
 * The table holds pointers it never reads: what a session is (mbedTLS's, in
 * PSRAM) and how it is freed are the caller's, and so is the lock. Pure C,
 * host-tested (main/tests/test_fos_tls_sessions.c).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Hosts kept. A page and the sites it links to are soon more than a few, and
 * a session is small (the table is under 600 bytes). */
#define FOS_TLS_SESSION_SLOTS 6
/* "host:port". A longer name is not kept (its requests handshake in full). */
#define FOS_TLS_SESSION_KEY_LEN 80
#define FOS_TLS_SESSION_MAX_AGE_MS (10 * 60 * 1000)

typedef struct {
    char key[FOS_TLS_SESSION_KEY_LEN];
    void *session; /* NULL: the slot is free */
    int64_t used_ms;
} fos_tls_session_slot_t;

typedef struct {
    fos_tls_session_slot_t slots[FOS_TLS_SESSION_SLOTS];
} fos_tls_sessions_t;

/* The name a host's session is kept under: its letters in lower case, ":",
 * its port. False when it does not fit `out` (or there is no host): such a
 * host is not kept. */
static inline bool fos_tls_session_key(const char *host, int port, char *out, size_t out_len)
{
    if (host == NULL || out == NULL || host[0] == '\0' || port <= 0 || port > 65535) return false;
    size_t n = strlen(host);
    /* ":65535" and the NUL */
    if (n + 7 > out_len) return false;
    for (size_t i = 0; i < n; i++) {
        char c = host[i];
        out[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
    }
    out[n++] = ':';
    char digits[6];
    int count = 0;
    while (port > 0) {
        digits[count++] = (char)('0' + port % 10);
        port /= 10;
    }
    while (count > 0) out[n++] = digits[--count];
    out[n] = '\0';
    return true;
}

/* The session kept for `key`, taken out of the table: the caller's now, to
 * offer and then to free or put back. NULL when there is none. One kept
 * longer than FOS_TLS_SESSION_MAX_AGE_MS unused is not offered: it comes
 * back through `*stale`, to be freed. */
static inline void *fos_tls_sessions_take(fos_tls_sessions_t *table, const char *key, int64_t now_ms,
                                          void **stale)
{
    if (stale != NULL) *stale = NULL;
    if (table == NULL || key == NULL || key[0] == '\0') return NULL;
    for (size_t i = 0; i < FOS_TLS_SESSION_SLOTS; i++) {
        fos_tls_session_slot_t *slot = &table->slots[i];
        if (slot->session == NULL || strcmp(slot->key, key) != 0) continue;
        void *session = slot->session;
        slot->session = NULL;
        slot->key[0] = '\0';
        if (now_ms - slot->used_ms > FOS_TLS_SESSION_MAX_AGE_MS) {
            if (stale != NULL) *stale = session;
            return NULL;
        }
        return session;
    }
    return NULL;
}

/* Keeps `session` for `key`, as of `now_ms`. What it took the place of comes
 * back to be freed: the session the key had, else one too old to offer, else
 * (the table full) the one used longest ago. NULL when a free slot took it.
 * A key that does not fit is not kept: `session` itself comes back. */
static inline void *fos_tls_sessions_put(fos_tls_sessions_t *table, const char *key, void *session,
                                         int64_t now_ms)
{
    if (table == NULL || session == NULL) return session;
    if (key == NULL || key[0] == '\0' || strlen(key) >= FOS_TLS_SESSION_KEY_LEN) return session;
    fos_tls_session_slot_t *into = NULL;
    fos_tls_session_slot_t *free_slot = NULL;
    fos_tls_session_slot_t *oldest = NULL;
    for (size_t i = 0; i < FOS_TLS_SESSION_SLOTS; i++) {
        fos_tls_session_slot_t *slot = &table->slots[i];
        if (slot->session == NULL) {
            if (free_slot == NULL) free_slot = slot;
            continue;
        }
        if (strcmp(slot->key, key) == 0) {
            into = slot;
            break;
        }
        if (oldest == NULL || slot->used_ms < oldest->used_ms) oldest = slot;
    }
    if (into == NULL) {
        /* A slot whose session is too old to offer goes before a fresh one. */
        if (oldest != NULL && now_ms - oldest->used_ms > FOS_TLS_SESSION_MAX_AGE_MS) into = oldest;
        else if (free_slot != NULL) into = free_slot;
        else into = oldest;
    }
    void *displaced = into->session;
    into->session = session;
    into->used_ms = now_ms;
    strcpy(into->key, key);
    return displaced;
}

#ifdef __cplusplus
}
#endif
