/*
 * Host tests for the provider URL rules (fos_url_guard.c): which hosts may
 * be dialed over plain http/ws, the ws_url-override guard, and the origin
 * comparison that keeps the frame's bearer on its own control plane. No
 * IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_url_guard.c main/tests/test_fos_url_guard.c \
 *      -o /tmp/test_fos_url_guard && /tmp/test_fos_url_guard
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The bias: a wrong "local" ships the claim token and bearer in the clear
 * to a host with a third party on the path; a wrong "public" costs a
 * developer an https certificate. Everything the parser cannot vouch for
 * must come back public / refused.
 */
#include <stdio.h>
#include <string.h>

#include "fos_url_guard.h"

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

static void expect_local(const char *host)
{
    g_checks++;
    if (!fos_url_host_is_local(host)) {
        g_failures++;
        printf("FAIL host %-36s classified PUBLIC, want local\n", host);
    }
}

static void expect_public(const char *host)
{
    g_checks++;
    if (fos_url_host_is_local(host)) {
        g_failures++;
        printf("FAIL host %-36s classified LOCAL, want public\n", host ? host : "(null)");
    }
}

static void expect_transport(const char *url, bool ws, bool want_ok)
{
    const char *why = (const char *)0x1;
    bool ok = fos_url_transport_ok(url, ws, &why);
    g_checks++;
    if (ok != want_ok) {
        g_failures++;
        printf("FAIL %s %-40s -> %s, want %s\n", ws ? "ws  " : "http", url ? url : "(null)",
               ok ? "ok" : "refused", want_ok ? "ok" : "refused");
    }
    g_checks++;
    if (ok ? why != NULL : (why == NULL || why == (const char *)0x1)) {
        g_failures++;
        printf("FAIL %s %-40s reason not set the way the result says\n", ws ? "ws  " : "http",
               url ? url : "(null)");
    }
}

static void expect_origin(const char *url, const char *want)
{
    char out[FOS_URL_GUARD_LEN];
    bool ok = fos_url_origin(url, out, sizeof(out));
    g_checks++;
    if (want == NULL) {
        if (ok) {
            g_failures++;
            printf("FAIL origin %-36s -> \"%s\", want refused\n", url ? url : "(null)", out);
        }
    } else if (!ok) {
        g_failures++;
        printf("FAIL origin %-36s refused, want \"%s\"\n", url, want);
    } else if (strcmp(out, want) != 0) {
        g_failures++;
        printf("FAIL origin %-36s -> \"%s\", want \"%s\"\n", url, out, want);
    }
}

/* --------------------------------------------------------------------- */
/* host_is_local                                                           */

static void test_local_names(void)
{
    expect_local("localhost");
    expect_local("LOCALHOST");
    expect_local("frame.local");
    expect_local("Kitchen.LOCAL");
    expect_local("dev.localhost");
    expect_local("a.b.c.local");
    expect_public("local");            /* the suffix needs a dot before it */
    expect_public("localhost.com");
    expect_public("notlocalhost");
    expect_public("mylocal");
    expect_public("frame.local.evil.com");
    expect_public("cloud.frameos.net");
    expect_public("");
    expect_public(NULL);
}

static void test_local_ipv4_ranges(void)
{
    expect_local("127.0.0.1");
    expect_local("127.255.255.255");
    expect_local("10.0.0.1");
    expect_local("10.255.255.255");
    expect_local("172.16.0.1");
    expect_local("172.31.255.255");
    expect_local("192.168.1.50");
    expect_local("169.254.10.10");
    expect_local("100.64.0.1");
    expect_local("100.127.255.255");

    expect_public("8.8.8.8");
    expect_public("172.15.255.255");
    expect_public("172.32.0.0");
    expect_public("192.169.0.1");
    expect_public("100.63.255.255");
    expect_public("100.128.0.0");
    expect_public("11.0.0.1");
    expect_public("126.0.0.1");
}

static void test_ipv4_parser_is_strict(void)
{
    /* Anything the strict parser cannot read is public, so plain http is
     * refused — the same answer Python's ipaddress gives the backend. */
    expect_public("010.0.0.1");       /* leading zero (octal to some stacks) */
    expect_public("10.0.0.01");
    expect_public("0127.0.0.1");
    expect_public("+10.0.0.1");
    expect_public("-10.0.0.1");
    expect_public(" 10.0.0.1");
    expect_public("10.0.0.1 ");
    expect_public("10.0.0");
    expect_public("10.0.0.1.1");
    expect_public("10..0.1");
    expect_public("10.0.0.256");
    expect_public("10.0.0.1000");
    expect_public("0x0a.0.0.1");
    expect_public("167772161");        /* 10.0.0.1 as one integer */
    expect_public("10.0.0.1/8");
    expect_public("10.0.0.1:80");      /* port must be stripped by the caller */
    expect_public("0.0.0.0");
    expect_public("255.255.255.255");
}

static void test_local_ipv6(void)
{
    expect_local("::1");
    expect_local("fe80::1");
    expect_local("FE80::abcd");
    expect_local("fc00::1");
    expect_local("fd12:3456::1");
    expect_local("FD00::1");
    expect_public("::2");
    expect_public("2001:db8::1");
    expect_public("fe81::1");           /* not link-local */
    expect_public("::ffff:10.0.0.1");   /* mapped v4 is not classified */
    expect_public("[::1]");             /* brackets must be stripped by the caller */
    expect_public("fb00::1");
    expect_public("fe00::1");
}

static void test_overlong_names_are_public(void)
{
    char host[200];
    memset(host, 'a', sizeof(host));
    memcpy(host + sizeof(host) - 7, ".local", 7); /* "aaa….local", 199 chars */
    expect_public(host);
}

/* --------------------------------------------------------------------- */
/* split + host_only                                                       */

static void test_split_scheme(void)
{
    bool secure = false;
    char host[FOS_URL_GUARD_LEN];

    CHECK(fos_url_split_scheme("https://cloud.frameos.net/api", "https://", "http://", &secure,
                               host, sizeof(host)), "https split refused");
    CHECK(secure, "https not flagged secure");
    CHECK(strcmp(host, "cloud.frameos.net") == 0, "host \"%s\"", host);

    CHECK(fos_url_split_scheme("HTTP://Frame.Local:8989?x=1#f", "https://", "http://", &secure,
                               host, sizeof(host)), "http split refused");
    CHECK(!secure, "http flagged secure");
    CHECK(strcmp(host, "Frame.Local:8989") == 0, "host \"%s\" keeps :port, drops ?#", host);

    CHECK(fos_url_split_scheme("wss://[::1]:3100/ws", "wss://", "ws://", &secure, host,
                               sizeof(host)), "wss split refused");
    CHECK(secure && strcmp(host, "[::1]:3100") == 0, "host \"%s\"", host);

    CHECK(!fos_url_split_scheme("ftp://x", "https://", "http://", &secure, host, sizeof(host)),
          "ftp accepted");
    CHECK(!fos_url_split_scheme("https://", "https://", "http://", &secure, host, sizeof(host)),
          "empty host accepted");
    CHECK(!fos_url_split_scheme("https:///path", "https://", "http://", &secure, host,
                                sizeof(host)), "no host accepted");
    CHECK(!fos_url_split_scheme("cloud.frameos.net", "https://", "http://", &secure, host,
                                sizeof(host)), "schemeless accepted");
    CHECK(!fos_url_split_scheme("ws://x", "https://", "http://", &secure, host, sizeof(host)),
          "ws accepted under the http rule");

    /* Userinfo is left in place so the host check downstream fails it. */
    CHECK(fos_url_split_scheme("http://user@10.0.0.1/", "https://", "http://", &secure, host,
                               sizeof(host)), "userinfo split refused");
    CHECK(strcmp(host, "user@10.0.0.1") == 0, "host \"%s\"", host);

    /* A host longer than the buffer is truncated, never overrun. */
    char small[8];
    CHECK(fos_url_split_scheme("http://averyveryverylonghost/", "https://", "http://", &secure,
                               small, sizeof(small)), "long host refused");
    CHECK(strlen(small) == 7, "long host not bounded: \"%s\"", small);
}

static void test_host_only(void)
{
    char out[FOS_URL_GUARD_LEN];
    fos_url_host_only("frame.local:8989", out, sizeof(out));
    CHECK(strcmp(out, "frame.local") == 0, "\"%s\"", out);
    fos_url_host_only("frame.local", out, sizeof(out));
    CHECK(strcmp(out, "frame.local") == 0, "\"%s\"", out);
    fos_url_host_only("[::1]:3100", out, sizeof(out));
    CHECK(strcmp(out, "::1") == 0, "\"%s\"", out);
    fos_url_host_only("[fe80::1]", out, sizeof(out));
    CHECK(strcmp(out, "fe80::1") == 0, "\"%s\"", out);
    fos_url_host_only("2001:db8::1", out, sizeof(out)); /* bare v6: no :port stripping */
    CHECK(strcmp(out, "2001:db8::1") == 0, "\"%s\"", out);
    fos_url_host_only("10.0.0.1:80", out, sizeof(out));
    CHECK(strcmp(out, "10.0.0.1") == 0, "\"%s\"", out);
    fos_url_host_only("[::1", out, sizeof(out)); /* unterminated bracket */
    CHECK(strcmp(out, "::1") == 0, "\"%s\"", out);
}

/* --------------------------------------------------------------------- */
/* transport rule                                                          */

static void test_http_transport_rule(void)
{
    expect_transport("https://cloud.frameos.net", false, true);
    expect_transport("HTTPS://cloud.frameos.net/", false, true);
    expect_transport("https://8.8.8.8:8443/x", false, true);
    expect_transport("http://localhost:3000", false, true);
    expect_transport("http://frame.local:8989", false, true);
    expect_transport("http://192.168.1.10:8989", false, true);
    expect_transport("http://10.0.0.1", false, true);
    expect_transport("http://[::1]:3000", false, true);
    expect_transport("http://[fe80::1]:3000", false, true);
    expect_transport("http://127.0.0.1", false, true);

    expect_transport("http://cloud.frameos.net", false, false);
    expect_transport("http://8.8.8.8", false, false);
    expect_transport("http://010.0.0.1", false, false);
    expect_transport("http://localhost.evil.com", false, false);
    expect_transport("http://user@10.0.0.1", false, false);   /* userinfo never local */
    expect_transport("http://10.0.0.1@evil.com", false, false);
    expect_transport("http://[2001:db8::1]", false, false);
    expect_transport("ws://localhost", false, false);         /* wrong wire shape */
    expect_transport("wss://cloud.frameos.net", false, false);
    expect_transport("ftp://localhost", false, false);
    expect_transport("cloud.frameos.net", false, false);
    expect_transport("", false, false);
    expect_transport(NULL, false, false);
    expect_transport("https://", false, false);
    expect_transport("http://", false, false);
}

static void test_ws_transport_rule(void)
{
    expect_transport("wss://cloud.frameos.net/frames/ws", true, true);
    expect_transport("WSS://x.example", true, true);
    expect_transport("ws://localhost:3100", true, true);
    expect_transport("ws://127.0.0.1:3100/ws", true, true);
    expect_transport("ws://frame.local:3100", true, true);
    expect_transport("ws://[::1]:3100", true, true);

    expect_transport("ws://cloud.frameos.net", true, false);
    expect_transport("ws://8.8.8.8:3100", true, false);
    expect_transport("https://cloud.frameos.net", true, false);  /* wrong wire shape */
    expect_transport("http://localhost:3100", true, false);
    expect_transport("", true, false);
    expect_transport(NULL, true, false);
}

static void test_reason_strings_name_the_shape(void)
{
    const char *why = NULL;
    CHECK(!fos_url_transport_ok("http://cloud.frameos.net", false, &why) && why &&
          strstr(why, "http://") && strstr(why, "localhost"), "http reason: %s", why ? why : "(null)");
    CHECK(!fos_url_transport_ok("ws://cloud.frameos.net", true, &why) && why &&
          strstr(why, "ws://"), "ws reason: %s", why ? why : "(null)");
    CHECK(!fos_url_transport_ok("ftp://x", true, &why) && why && strstr(why, "wss://"),
          "ws shape reason: %s", why ? why : "(null)");
    CHECK(!fos_url_transport_ok(NULL, false, &why) && why && strcmp(why, "empty") == 0,
          "empty reason: %s", why ? why : "(null)");
    /* reason is optional */
    CHECK(!fos_url_transport_ok("http://cloud.frameos.net", false, NULL), "NULL reason crashed?");
}

/* --------------------------------------------------------------------- */
/* ws_url override vs provider                                             */

static void test_ws_url_matches_provider(void)
{
    /* No override: nothing to check. */
    CHECK(fos_ws_url_matches_provider(NULL, "https://cloud.frameos.net"), "NULL override refused");
    CHECK(fos_ws_url_matches_provider("", "https://cloud.frameos.net"), "empty override refused");
    CHECK(fos_ws_url_matches_provider("", NULL), "empty override with no cloud_url refused");

    /* A public override is always plausible (the transport rule is separate). */
    CHECK(fos_ws_url_matches_provider("wss://hub.frameos.net/ws", "https://cloud.frameos.net"),
          "public override refused");
    CHECK(fos_ws_url_matches_provider("ws://192.168.1.5:3100", "https://cloud.frameos.net"),
          "LAN override refused (not loopback)");

    /* Loopback override needs a loopback provider: the board-moved-clouds case. */
    CHECK(!fos_ws_url_matches_provider("ws://localhost:3100", "https://cloud.frameos.net"),
          "stale localhost override accepted");
    CHECK(!fos_ws_url_matches_provider("ws://127.0.0.1:3100", "https://cloud.frameos.net"),
          "stale 127.0.0.1 override accepted");
    CHECK(!fos_ws_url_matches_provider("ws://[::1]:3100", "https://cloud.frameos.net"),
          "stale [::1] override accepted");
    CHECK(!fos_ws_url_matches_provider("ws://localhost:3100", NULL), "loopback with no provider accepted");
    CHECK(!fos_ws_url_matches_provider("ws://localhost:3100", ""), "loopback with empty provider accepted");

    CHECK(fos_ws_url_matches_provider("ws://localhost:3100", "http://localhost:3000"),
          "dev override refused");
    CHECK(fos_ws_url_matches_provider("ws://127.0.0.1:3100", "http://localhost:3000"),
          "dev override (mixed loopback spellings) refused");
    CHECK(fos_ws_url_matches_provider("ws://[::1]:3100", "http://[::1]:3000"),
          "dev v6 override refused");
    /* The name has to be the host, not a path component. */
    CHECK(fos_ws_url_matches_provider("wss://hub.frameos.net/localhost", "https://cloud.frameos.net"),
          "\"localhost\" in the path treated as loopback");
}

/* --------------------------------------------------------------------- */
/* origin + first party                                                    */

static void test_url_origin(void)
{
    expect_origin("https://cloud.frameos.net/api/x?y#z", "https://cloud.frameos.net");
    expect_origin("HTTPS://Cloud.FrameOS.net", "https://cloud.frameos.net");
    expect_origin("http://192.168.1.10:8989/", "http://192.168.1.10:8989");
    expect_origin("wss://hub.frameos.net/frames/ws", "https://hub.frameos.net");
    expect_origin("ws://localhost:3100", "http://localhost:3100");
    expect_origin("https://[::1]:3000/x", "https://[::1]:3000");
    expect_origin("https://cloud.frameos.net", "https://cloud.frameos.net");

    expect_origin("https://user@cloud.frameos.net/", NULL);       /* userinfo */
    expect_origin("https://cloud.frameos.net@evil.com/", NULL);
    expect_origin("https://evil.com/x@cloud.frameos.net", "https://evil.com"); /* @ in path is fine */
    expect_origin("ftp://cloud.frameos.net", NULL);
    expect_origin("cloud.frameos.net", NULL);
    expect_origin("https://", NULL);
    expect_origin("https:///x", NULL);
    expect_origin("", NULL);
    expect_origin(NULL, NULL);

    /* Output is bounded, and an origin that does not fit is a refusal. */
    char small[16];
    CHECK(!fos_url_origin("https://cloud.frameos.net", small, sizeof(small)), "overlong origin accepted");
    CHECK(fos_url_origin("https://a.b", small, sizeof(small)) && strcmp(small, "https://a.b") == 0,
          "short origin refused");
}

static void test_download_is_first_party(void)
{
    const char *base = "https://cloud.frameos.net";
    const char *ws = "wss://hub.frameos.net/frames/ws";

    CHECK(fos_url_download_is_first_party("https://cloud.frameos.net/api/ota/x.bin", base, ws),
          "base origin refused");
    CHECK(fos_url_download_is_first_party("HTTPS://CLOUD.FRAMEOS.NET/x.bin", base, ws),
          "case-insensitive base refused");
    CHECK(fos_url_download_is_first_party("https://hub.frameos.net/ota/x.bin", base, ws),
          "ws_url origin refused");
    CHECK(fos_url_download_is_first_party("https://hub.frameos.net/x", base, NULL) == false,
          "ws origin accepted without a ws_url");
    CHECK(fos_url_download_is_first_party("https://hub.frameos.net/x", base, "") == false,
          "ws origin accepted with an empty ws_url");

    CHECK(!fos_url_download_is_first_party("https://github.com/FrameOS/x.bin", base, ws),
          "third party accepted");
    CHECK(!fos_url_download_is_first_party("https://cloud.frameos.net.evil.com/x", base, ws),
          "lookalike suffix accepted");
    CHECK(!fos_url_download_is_first_party("https://cloud.frameos.net:8443/x", base, ws),
          "different port accepted");
    CHECK(!fos_url_download_is_first_party("http://cloud.frameos.net/x", base, ws),
          "scheme downgrade accepted");
    CHECK(!fos_url_download_is_first_party("https://cloud.frameos.net@evil.com/x", base, ws),
          "userinfo lookalike accepted");
    CHECK(!fos_url_download_is_first_party("https://evil.com/?u=https://cloud.frameos.net", base, ws),
          "origin in the query accepted");
    CHECK(!fos_url_download_is_first_party("/relative/x.bin", base, ws), "relative url accepted");
    CHECK(!fos_url_download_is_first_party("", base, ws), "empty url accepted");
    CHECK(!fos_url_download_is_first_party(NULL, base, ws), "NULL url accepted");
    CHECK(!fos_url_download_is_first_party("https://x/y", NULL, NULL), "no base, no ws accepted");

    /* A LAN backend with its port. */
    CHECK(fos_url_download_is_first_party("http://192.168.1.10:8989/api/frames/1/ota.bin",
                                          "http://192.168.1.10:8989", NULL), "LAN base refused");
    CHECK(!fos_url_download_is_first_party("http://192.168.1.10/ota.bin", "http://192.168.1.10:8989",
                                           NULL), "LAN base without port accepted");
}

int main(void)
{
    test_local_names();
    test_local_ipv4_ranges();
    test_ipv4_parser_is_strict();
    test_local_ipv6();
    test_overlong_names_are_public();
    test_split_scheme();
    test_host_only();
    test_http_transport_rule();
    test_ws_transport_rule();
    test_reason_strings_name_the_shape();
    test_ws_url_matches_provider();
    test_url_origin();
    test_download_is_first_party();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
