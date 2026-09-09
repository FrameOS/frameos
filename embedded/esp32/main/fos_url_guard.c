/* See fos_url_guard.h. Host-testable: main/tests/test_fos_url_guard.c. */

/* glibc hides strncasecmp / strtok_r behind feature macros under -std=c11
 * (the host tests build with it); harmless under the IDF's gnu17. */
#if defined(__STRICT_ANSI__) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200112L
#endif

#include "fos_url_guard.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

/* strlcpy without strlcpy: not declared under strict C11 on glibc. */
static void copy_bounded(char *dst, size_t dst_len, const char *src)
{
    if (dst_len == 0) return;
    size_t n = strlen(src);
    if (n >= dst_len) n = dst_len - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* Strict dotted-quad parser: exactly four 1-3 digit decimal groups, each
 * 0-255, single dots, nothing before or after. Deliberately stricter than the
 * `sscanf(host, "%u.%u.%u.%u%c", ...)` this replaces, which also accepted
 * leading whitespace, a `+`/`-` sign and leading zeros ("010.0.0.1"): Python's
 * `ipaddress.ip_address()` — the backend half of this rule, in
 * backend/app/utils/cloud_link.py::_is_local_host — rejects all three, so the
 * strict reading is the one that matches, and every rejection here fails
 * closed (the host is treated as public, so plain http:// is refused). */
static bool parse_ipv4_literal(const char *host, unsigned *a, unsigned *b,
                               unsigned *c, unsigned *d)
{
    unsigned *out[4] = { a, b, c, d };
    const char *p = host;

    for (int i = 0; i < 4; i++) {
        if (i > 0) {
            if (*p != '.') return false;
            p++;
        }
        if (*p < '0' || *p > '9') return false;
        if (*p == '0' && p[1] >= '0' && p[1] <= '9') return false;  /* no leading zeros */
        unsigned value = 0;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            if (++digits > 3) return false;
            value = value * 10 + (unsigned)(*p - '0');
            p++;
        }
        if (value > 255) return false;
        *out[i] = value;
    }
    return *p == '\0';
}

bool fos_url_host_is_local(const char *host)
{
    if (!host || !host[0]) return false;

    /* Case-insensitive suffix/exact name checks. */
    size_t len = strlen(host);
    char lower[128];
    if (len < sizeof(lower)) { /* longer than this is never a local name */
        for (size_t i = 0; i <= len; i++) {
            char c = host[i];
            lower[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
        }
        if (strcmp(lower, "localhost") == 0) return true;
        size_t n = strlen(lower);
        if (n > 6 && strcmp(lower + n - 6, ".local") == 0) return true;
        if (n > 10 && strcmp(lower + n - 10, ".localhost") == 0) return true;
    }

    /* IPv6 literals arrive without brackets here. */
    if (strchr(host, ':')) {
        if (strcmp(host, "::1") == 0) return true;
        if (strncasecmp(host, "fe80:", 5) == 0) return true;          /* link-local */
        if ((host[0] == 'f' || host[0] == 'F') &&
            (host[1] == 'c' || host[1] == 'C' || host[1] == 'd' || host[1] == 'D')) {
            return true;                                              /* ULA fc00::/7 */
        }
        return false;
    }

    unsigned a = 0, b = 0, c = 0, d = 0;
    if (!parse_ipv4_literal(host, &a, &b, &c, &d)) return false;
    if (a == 127) return true;                                        /* loopback */
    if (a == 10) return true;                                         /* RFC1918 */
    if (a == 172 && b >= 16 && b <= 31) return true;                  /* RFC1918 */
    if (a == 192 && b == 168) return true;                            /* RFC1918 */
    if (a == 169 && b == 254) return true;                            /* link-local */
    if (a == 100 && b >= 64 && b <= 127) return true;                 /* CGNAT */
    return false;
}

bool fos_url_split_scheme(const char *url, const char *secure_scheme,
                          const char *plain_scheme, bool *is_secure,
                          char *host, size_t host_len)
{
    const char *rest;
    if (strncasecmp(url, secure_scheme, strlen(secure_scheme)) == 0) {
        *is_secure = true;
        rest = url + strlen(secure_scheme);
    } else if (strncasecmp(url, plain_scheme, strlen(plain_scheme)) == 0) {
        *is_secure = false;
        rest = url + strlen(plain_scheme);
    } else {
        return false;
    }
    copy_bounded(host, host_len, rest);
    size_t cut = strcspn(host, "/?#");
    host[cut] = '\0';
    /* Anything with userinfo, or otherwise not a bare host[:port], is left
     * intact here and fails the host check below rather than being guessed. */
    return host[0] != '\0';
}

void fos_url_host_only(const char *hostport, char *out, size_t out_len)
{
    copy_bounded(out, out_len, hostport);
    if (out[0] == '[') {
        memmove(out, out + 1, strlen(out)); /* includes the NUL */
        char *close = strchr(out, ']');
        if (close) *close = '\0';
        return;
    }
    /* A bare IPv6 literal has several colons; only strip a single :port. */
    char *colon = strrchr(out, ':');
    if (colon && strchr(out, ':') == colon) *colon = '\0';
}

bool fos_url_transport_ok(const char *url, bool ws, const char **reason)
{
    const char *why = NULL;
    bool is_secure = false;
    char hostport[FOS_URL_GUARD_LEN];
    char host[FOS_URL_GUARD_LEN];
    bool ok = false;

    if (!url || !url[0]) {
        why = "empty";
    } else if (!fos_url_split_scheme(url, ws ? "wss://" : "https://",
                                     ws ? "ws://" : "http://", &is_secure,
                                     hostport, sizeof(hostport))) {
        why = ws ? "must be a ws:// or wss:// URL"
                 : "must be an http:// or https:// URL";
    } else if (is_secure) {
        ok = true;
    } else {
        fos_url_host_only(hostport, host, sizeof(host));
        if (fos_url_host_is_local(host)) {
            ok = true;
        } else {
            why = ws ? "ws:// is allowed only for localhost, .local and "
                       "private-network hosts (development)"
                     : "http:// is allowed only for localhost, .local and "
                       "private-network hosts (development)";
        }
    }
    if (reason) *reason = why;
    return ok;
}

bool fos_ws_url_matches_provider(const char *ws_url, const char *cloud_url)
{
    if (ws_url == NULL || ws_url[0] == '\0') return true;
    bool ws_loopback = strstr(ws_url, "://localhost") != NULL ||
                       strstr(ws_url, "://127.0.0.1") != NULL ||
                       strstr(ws_url, "://[::1]") != NULL;
    if (!ws_loopback) return true;
    if (cloud_url == NULL) return false;
    return strstr(cloud_url, "://localhost") != NULL ||
           strstr(cloud_url, "://127.0.0.1") != NULL ||
           strstr(cloud_url, "://[::1]") != NULL;
}

bool fos_url_origin(const char *url, char *out, size_t out_len)
{
    const char *scheme;
    const char *rest;
    if (!url) return false;
    if (strncasecmp(url, "https://", 8) == 0) { scheme = "https://"; rest = url + 8; }
    else if (strncasecmp(url, "http://", 7) == 0) { scheme = "http://"; rest = url + 7; }
    else if (strncasecmp(url, "wss://", 6) == 0) { scheme = "https://"; rest = url + 6; }
    else if (strncasecmp(url, "ws://", 5) == 0) { scheme = "http://"; rest = url + 5; }
    else return false;
    size_t host_len = strcspn(rest, "/?#");
    if (host_len == 0 || memchr(rest, '@', host_len)) return false;
    int n = snprintf(out, out_len, "%s%.*s", scheme, (int)host_len, rest);
    if (n <= 0 || (size_t)n >= out_len) return false;
    for (char *p = out; *p; p++) *p = (char)tolower((unsigned char)*p);
    return true;
}

bool fos_url_download_is_first_party(const char *download_url, const char *base_url,
                                     const char *ws_url)
{
    char have[FOS_URL_GUARD_LEN];
    char want[FOS_URL_GUARD_LEN];
    if (!fos_url_origin(download_url, have, sizeof(have))) return false;
    if (base_url && fos_url_origin(base_url, want, sizeof(want)) && strcmp(want, have) == 0) {
        return true;
    }
    if (ws_url && ws_url[0] && fos_url_origin(ws_url, want, sizeof(want)) &&
        strcmp(want, have) == 0) {
        return true;
    }
    return false;
}
