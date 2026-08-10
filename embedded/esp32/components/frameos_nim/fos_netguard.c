/*
 * Private-network egress policy for scene HTTP — see fos_netguard.h for what
 * this is for and why it exists on cloud-managed frames.
 *
 * Deliberately log-free and IDF-free apart from the FreeRTOS spinlock and the
 * getaddrinfo() in fos_netguard_url_allowed(): the callers own the ESP_LOGW,
 * and everything that decides "private or not" is plain C over strings so
 * main/tests/test_fos_netguard.c can compile this exact file with cc and run
 * the whole classifier on a laptop.
 */
#include "fos_netguard.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>

#ifdef ESP_PLATFORM
#include "freertos/FreeRTOS.h"
/* The policy is written by the cloud task and read by whichever task is
 * rendering, so the two words below need a lock. A spinlock rather than a
 * mutex because it is statically initialised: there is no init call to forget,
 * and a reader that runs before the cloud task ever starts still sees a
 * consistent (policy-off) state. The critical sections hold nothing but a few
 * short strcasecmp()s. */
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
#define NETGUARD_LOCK() portENTER_CRITICAL(&s_lock)
#define NETGUARD_UNLOCK() portEXIT_CRITICAL(&s_lock)
#else
#define NETGUARD_LOCK() ((void)0)
#define NETGUARD_UNLOCK() ((void)0)
#endif

typedef struct {
    char host[FOS_NETGUARD_EXEMPT_HOST_LEN];
    int port; /* <= 0 = any port on this host */
} netguard_exempt_t;

static bool s_block_local = false;
static netguard_exempt_t s_exempt[FOS_NETGUARD_EXEMPT_MAX];
static size_t s_exempt_count = 0;

/* ------------------------------------------------------------- IP literals */

/* Strict dotted-quad: exactly four decimal fields, each 0..255, no leading
 * zeros. Anything else fails to parse, and every caller reads a parse failure
 * as "private".
 *
 * Rejecting leading zeros is stricter than the Nim classifier
 * (isPrivateNetworkAddress accepts them as decimal) and that difference closes
 * a hole rather than adding pedantry. lwIP turns host strings into addresses
 * with ip4addr_aton(), which has inet_aton() semantics: a leading 0 is octal
 * and a leading 0x is hex. "0177.0.0.1" read as decimal is 177.0.0.1 (public)
 * but lwIP connects it to 127.0.0.1 (loopback). Refusing the ambiguous forms
 * classifies them as private instead of handing out that mismatch. The 0x
 * forms contain letters, so they take the hostname path and get caught by the
 * resolved-address check. */
static bool parse_ipv4(const char *s, uint8_t out[4])
{
    if (s == NULL) return false;
    for (int field = 0; field < 4; field++) {
        if (field > 0) {
            if (*s != '.') return false;
            s++;
        }
        if (*s < '0' || *s > '9') return false;
        const bool leading_zero = (*s == '0');
        unsigned value = 0;
        int digits = 0;
        while (*s >= '0' && *s <= '9') {
            value = value * 10u + (unsigned)(*s - '0');
            digits++;
            if (value > 255u || digits > 3) return false;
            s++;
        }
        if (leading_zero && digits > 1) return false;
        out[field] = (uint8_t)value;
    }
    return *s == '\0';
}

static int hex_value(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* RFC 4291 textual IPv6, brackets already stripped: hex groups, at most one
 * "::" run, an optional trailing dotted quad. No zone id ("fe80::1%eth0")
 * — that fails to parse, which means private, which is right for a
 * link-local address anyway. */
static bool parse_ipv6(const char *s, uint8_t out[16])
{
    uint8_t buf[16];
    int pos = 0;  /* bytes written so far */
    int gap = -1; /* byte offset where "::" stood, -1 = no "::" seen */

    if (s == NULL || *s == '\0') return false;
    memset(buf, 0, sizeof(buf));

    if (s[0] == ':') {
        if (s[1] != ':') return false; /* a single leading colon is invalid */
        s += 2;
        gap = 0;
        if (*s == '\0') { /* "::" — the unspecified address */
            memcpy(out, buf, sizeof(buf));
            return true;
        }
    }

    while (*s != '\0') {
        /* A dotted quad is only an IPv4 tail when no colon precedes its dot;
         * in "ffff:127.0.0.1" the '.' belongs to the *next* element. */
        const char *dot = strchr(s, '.');
        const char *colon = strchr(s, ':');
        if (dot != NULL && (colon == NULL || dot < colon)) {
            uint8_t quad[4];
            if (pos + 4 > 16) return false;
            if (!parse_ipv4(s, quad)) return false;
            memcpy(buf + pos, quad, sizeof(quad));
            pos += 4;
            break; /* parse_ipv4 only succeeds on a whole string */
        }

        unsigned group = 0;
        int digits = 0;
        while (hex_value(*s) >= 0) {
            group = group * 16u + (unsigned)hex_value(*s);
            digits++;
            if (digits > 4) return false;
            s++;
        }
        if (digits == 0) return false;
        if (pos + 2 > 16) return false;
        buf[pos++] = (uint8_t)(group >> 8);
        buf[pos++] = (uint8_t)(group & 0xffu);

        if (*s == '\0') break;
        if (*s != ':') return false; /* zone ids, prefix lengths, junk */
        s++;
        if (*s == ':') { /* the "::" run */
            if (gap >= 0) return false; /* only one is allowed */
            gap = pos;
            s++;
            if (*s == '\0') break;
        } else if (*s == '\0') {
            return false; /* a trailing single colon */
        }
    }

    if (gap < 0) {
        if (pos != 16) return false;
    } else {
        if (pos >= 16) return false; /* "::" has to stand for something */
        const size_t tail = (size_t)(pos - gap);
        memmove(buf + 16 - tail, buf + gap, tail);
        memset(buf + gap, 0, 16 - tail - (size_t)gap);
    }
    memcpy(out, buf, sizeof(buf));
    return true;
}

/* The IPv4 half of the Nim isPrivateNetworkAddress, byte for byte. */
static bool ipv4_is_private(const uint8_t b[4])
{
    if (b[0] == 0) return true;                                /* 0/8, incl. unspecified */
    if (b[0] == 10) return true;                               /* 10/8 */
    if (b[0] == 100 && (b[1] & 0xc0u) == 64) return true;      /* 100.64/10 CGNAT */
    if (b[0] == 127) return true;                              /* loopback */
    if (b[0] == 169 && b[1] == 254) return true;               /* link-local */
    if (b[0] == 172 && (b[1] & 0xf0u) == 16) return true;      /* 172.16/12 */
    if (b[0] == 192 && b[1] == 0 && b[2] == 0) return true;    /* 192.0.0.0/24 */
    if (b[0] == 192 && b[1] == 168) return true;               /* 192.168/16 */
    if (b[0] == 198 && (b[1] & 0xfeu) == 18) return true;      /* 198.18/15 benchmarking */
    if ((b[0] & 0xf0u) == 224) return true;                    /* 224/4 multicast */
    if (b[0] >= 240) return true;                              /* 240/4, incl. broadcast */
    return false;
}

static bool ipv6_is_private(const uint8_t b[16])
{
    /* ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (the deprecated
     * IPv4-compatible form, which carries no ffff marker at all): both hold an
     * IPv4 address in the low 32 bits, so classify that instead. Missing the
     * second form is what once let ::127.0.0.1 through as "public". */
    bool zero_prefix = true;
    for (int i = 0; i < 10; i++) {
        if (b[i] != 0) zero_prefix = false;
    }
    const bool embeds_ipv4 = zero_prefix &&
        ((b[10] == 0xff && b[11] == 0xff) || (b[10] == 0 && b[11] == 0));

    /* :: and ::1 come first: they are the unspecified/loopback addresses, not
     * an embedded 0.0.0.x. */
    bool all_zero = true;
    for (int i = 0; i < 15; i++) {
        if (b[i] != 0) all_zero = false;
    }
    if (all_zero && b[15] <= 1) return true;

    if (embeds_ipv4) return ipv4_is_private(b + 12);

    /* 64:ff9b::/96 — the well-known NAT64 prefix, another wrapper around an
     * IPv4 destination. */
    bool nat64 = b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b;
    for (int i = 4; nat64 && i < 12; i++) {
        if (b[i] != 0) nat64 = false;
    }
    if (nat64) return ipv4_is_private(b + 12);

    if ((b[0] & 0xfeu) == 0xfc) return true;                   /* fc00::/7 ULA */
    if (b[0] == 0xfe && (b[1] & 0xc0u) == 0x80) return true;   /* fe80::/10 link-local */
    if (b[0] == 0xff) return true;                             /* ff00::/8 multicast */
    return false;
}

bool fos_netguard_is_private_ip(const char *ip)
{
    uint8_t v4[4];
    uint8_t v6[16];

    if (ip == NULL || ip[0] == '\0') return true;
    if (parse_ipv4(ip, v4)) return ipv4_is_private(v4);
    if (parse_ipv6(ip, v6)) return ipv6_is_private(v6);
    return true; /* unparseable: fail closed, see the header */
}

/* ------------------------------------------------------------------- policy */

void fos_netguard_set_policy(bool block_local)
{
    NETGUARD_LOCK();
    s_block_local = block_local;
    NETGUARD_UNLOCK();
}

bool fos_netguard_policy_active(void)
{
    NETGUARD_LOCK();
    const bool active = s_block_local;
    NETGUARD_UNLOCK();
    return active;
}

void fos_netguard_clear_exempt(void)
{
    NETGUARD_LOCK();
    s_exempt_count = 0;
    NETGUARD_UNLOCK();
}

bool fos_netguard_set_exempt(const char *host, int port)
{
    if (host == NULL || host[0] == '\0') return false;
    if (strlen(host) >= sizeof(s_exempt[0].host)) return false;

    bool stored = false;
    NETGUARD_LOCK();
    if (s_exempt_count < FOS_NETGUARD_EXEMPT_MAX) {
        /* Lowercased on the way in, like the native build's exempt list, so
         * the hot path only ever does one case-insensitive compare. */
        char *dst = s_exempt[s_exempt_count].host;
        size_t i = 0;
        for (; host[i] != '\0'; i++) {
            const char c = host[i];
            dst[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
        }
        dst[i] = '\0';
        s_exempt[s_exempt_count].port = port;
        s_exempt_count++;
        stored = true;
    }
    NETGUARD_UNLOCK();
    return stored;
}

static bool exempt_match(const char *host, int port)
{
    bool match = false;
    NETGUARD_LOCK();
    for (size_t i = 0; i < s_exempt_count && !match; i++) {
        if (s_exempt[i].port > 0 && s_exempt[i].port != port) continue;
        if (strcasecmp(s_exempt[i].host, host) == 0) match = true;
    }
    NETGUARD_UNLOCK();
    return match;
}

/* ---------------------------------------------------------------- URL parse */

bool fos_netguard_parse_url(const char *url, char *host, size_t host_len, int *port)
{
    if (host == NULL || host_len == 0 || port == NULL) return false;
    host[0] = '\0';
    *port = 0;
    if (url == NULL) return false;

    int default_port;
    const char *rest;
    if (strncasecmp(url, "https://", 8) == 0) {
        default_port = 443;
        rest = url + 8;
    } else if (strncasecmp(url, "http://", 7) == 0) {
        default_port = 80;
        rest = url + 7;
    } else {
        /* Not a scheme this guard understands. The caller blocks rather than
         * waving it through: an unknown scheme is exactly the shape a bypass
         * attempt takes, and esp_http_client would refuse it anyway. */
        return false;
    }

    const char *authority = rest;
    size_t authority_len = strcspn(rest, "/?#");

    /* Userinfo is the classic parser trap: in http://example.com@192.168.1.1/
     * the host is the LAN address, not example.com. Split on the LAST '@' in
     * the authority — a password may legitimately contain one. */
    for (size_t i = authority_len; i > 0; i--) {
        if (authority[i - 1] == '@') {
            authority += i;
            authority_len -= i;
            break;
        }
    }
    if (authority_len == 0) return false;

    const char *host_start;
    size_t host_chars;
    const char *port_str = NULL;
    size_t port_chars = 0;

    if (authority[0] == '[') {
        const char *close = memchr(authority, ']', authority_len);
        if (close == NULL) return false;
        host_start = authority + 1;
        host_chars = (size_t)(close - host_start);
        const size_t after = (size_t)(close + 1 - authority);
        if (after < authority_len) {
            if (authority[after] != ':') return false;
            port_str = authority + after + 1;
            port_chars = authority_len - after - 1;
        }
    } else {
        const char *colon = memchr(authority, ':', authority_len);
        host_start = authority;
        if (colon != NULL) {
            host_chars = (size_t)(colon - authority);
            port_str = colon + 1;
            port_chars = authority_len - host_chars - 1;
            /* A second colon means an unbracketed IPv6 literal (illegal in a
             * URL) or junk. Either way this is not a URL to guess about. */
            if (memchr(port_str, ':', port_chars) != NULL) return false;
        } else {
            host_chars = authority_len;
        }
    }
    if (host_chars == 0 || host_chars >= host_len) return false;

    int value = default_port;
    if (port_str != NULL && port_chars > 0) { /* "host:" is the default port */
        if (port_chars > 5) return false;
        value = 0;
        for (size_t i = 0; i < port_chars; i++) {
            if (port_str[i] < '0' || port_str[i] > '9') return false;
            value = value * 10 + (port_str[i] - '0');
        }
        if (value < 1 || value > 65535) return false;
    }

    memcpy(host, host_start, host_chars);
    host[host_chars] = '\0';
    *port = value;
    return true;
}

/* ------------------------------------------------------------- the decision */

/* Does this host consist only of digits and dots? Such a string is never a
 * DNS name in practice, and if the strict parser above rejected it the two
 * sides disagree about what it means (see parse_ipv4). Private, then. */
static bool looks_numeric(const char *host)
{
    for (size_t i = 0; host[i] != '\0'; i++) {
        if ((host[i] < '0' || host[i] > '9') && host[i] != '.') return false;
    }
    return true;
}

bool fos_netguard_url_allowed(const char *url, char *reason, size_t reason_len)
{
    if (reason != NULL && reason_len > 0) reason[0] = '\0';

    NETGUARD_LOCK();
    const bool blocking = s_block_local;
    NETGUARD_UNLOCK();
    if (!blocking) return true;

    char host[FOS_NETGUARD_HOST_LEN];
    int port = 0;
    if (!fos_netguard_parse_url(url, host, sizeof(host), &port)) {
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "not an http(s) URL with a usable host");
        }
        return false;
    }
    if (exempt_match(host, port)) return true;

    uint8_t v4[4];
    uint8_t v6[16];
    if (parse_ipv4(host, v4)) {
        if (!ipv4_is_private(v4)) return true;
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "%s is a private address", host);
        }
        return false;
    }
    if (parse_ipv6(host, v6)) {
        if (!ipv6_is_private(v6)) return true;
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "%s is a private address", host);
        }
        return false;
    }
    if (looks_numeric(host)) {
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "%s is not a well-formed IP address", host);
        }
        return false;
    }

    /* A name. Reject if ANY answer is private: a DNS-rebinding record set that
     * mixes one public and one RFC1918 address must not pass, and the
     * connect() that follows takes whichever the stack prefers. */
    struct addrinfo hints;
    struct addrinfo *result = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, NULL, &hints, &result) != 0 || result == NULL) {
        /* Unresolvable. The request is going to fail regardless, so the only
         * question is which error the scene sees; say what we know. */
        if (result != NULL) freeaddrinfo(result);
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "%s did not resolve", host);
        }
        return false;
    }

    bool allowed = true;
    for (const struct addrinfo *ai = result; ai != NULL && allowed; ai = ai->ai_next) {
        if (ai->ai_addr == NULL) continue;
        if (ai->ai_family == AF_INET) {
            const struct sockaddr_in *sin = (const struct sockaddr_in *)(const void *)ai->ai_addr;
            uint8_t bytes[4];
            memcpy(bytes, &sin->sin_addr, sizeof(bytes));
            if (ipv4_is_private(bytes)) allowed = false;
/* lwIP collapses AF_INET6 onto AF_UNSPEC and omits struct sockaddr_in6 when
 * built without IPv6, so testing for definedness is useless — it is always
 * defined. Without the branch an IPv6 answer falls into the else below and is
 * refused, which is the right way round. */
#if AF_INET6 != AF_UNSPEC
        } else if (ai->ai_family == AF_INET6) {
            const struct sockaddr_in6 *sin6 = (const struct sockaddr_in6 *)(const void *)ai->ai_addr;
            uint8_t bytes[16];
            memcpy(bytes, &sin6->sin6_addr, sizeof(bytes));
            if (ipv6_is_private(bytes)) allowed = false;
#endif
        } else {
            allowed = false; /* an address family we cannot classify */
        }
    }
    freeaddrinfo(result);

    if (!allowed) {
        if (reason != NULL && reason_len > 0) {
            snprintf(reason, reason_len, "%s resolves to a private address", host);
        }
    }
    return allowed;
}
