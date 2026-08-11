/*
 * Host tests for the private-network egress guard. No IDF, no CMake, no mocks:
 * fos_netguard.c keeps its classifier and URL parser as plain C over strings
 * precisely so the interesting half can be argued about on a laptop.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_nim/include \
 *      components/frameos_nim/fos_netguard.c main/tests/test_fos_netguard.c \
 *      -o /tmp/test_fos_netguard && /tmp/test_fos_netguard
 *
 * (backend/app/tasks/tests/test_esp32_netguard.py does exactly that in CI.)
 *
 * The bias under test is one-directional, like the SD probe next door but for
 * the opposite reason: a wrong "public" lets a cloud-installed scene reach the
 * owner's router, a wrong "private" costs a scene one unreachable host. So
 * every input this cannot parse must come back private, and most of the cases
 * below assert exactly that.
 */
#include <stdio.h>
#include <string.h>

#include "fos_netguard.h"

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

static void expect_private(const char *ip)
{
    g_checks++;
    if (!fos_netguard_is_private_ip(ip)) {
        g_failures++;
        printf("FAIL %-42s classified PUBLIC, want private\n", ip);
    }
}

static void expect_public(const char *ip)
{
    g_checks++;
    if (fos_netguard_is_private_ip(ip)) {
        g_failures++;
        printf("FAIL %-42s classified PRIVATE, want public\n", ip);
    }
}

/* --------------------------------------------------------------------- */
/* IPv4 classification                                                     */

static void test_ipv4_private_ranges(void)
{
    expect_private("0.0.0.0");
    expect_private("0.1.2.3");          /* 0/8 */
    expect_private("10.0.0.1");
    expect_private("10.255.255.255");
    expect_private("100.64.0.1");       /* CGNAT low edge */
    expect_private("100.127.255.254");  /* CGNAT high edge */
    expect_private("127.0.0.1");
    expect_private("127.255.255.255");
    expect_private("169.254.1.1");      /* link-local */
    expect_private("172.16.0.1");
    expect_private("172.31.255.254");
    expect_private("192.0.0.1");        /* IETF protocol assignments */
    expect_private("192.168.1.1");
    expect_private("198.18.0.1");       /* benchmarking */
    expect_private("198.19.255.254");
    expect_private("224.0.0.1");        /* multicast */
    expect_private("239.255.255.250");  /* SSDP — the classic LAN pivot */
    expect_private("240.0.0.1");
    expect_private("255.255.255.255");
}

static void test_ipv4_public_and_edges(void)
{
    expect_public("8.8.8.8");
    expect_public("1.1.1.1");
    expect_public("93.184.216.34");
    /* One step outside each private block: these must stay reachable. */
    expect_public("9.255.255.255");
    expect_public("11.0.0.1");
    expect_public("100.63.255.255");    /* just below CGNAT */
    expect_public("100.128.0.1");       /* just above CGNAT */
    expect_public("126.255.255.255");
    expect_public("128.0.0.1");
    expect_public("169.253.255.255");
    expect_public("169.255.0.1");
    expect_public("172.15.255.255");
    expect_public("172.32.0.1");
    expect_public("192.0.1.1");         /* 192.0.0.0/24 is /24, not /16 */
    expect_public("192.167.255.255");
    expect_public("192.169.0.1");
    expect_public("198.17.255.255");
    expect_public("198.20.0.1");
    expect_public("223.255.255.255");   /* just below multicast */
    expect_public("8.8.4.4");
}

static void test_unparseable_is_private(void)
{
    /* Fail closed. Every one of these is about to be handed to connect(). */
    expect_private("");
    expect_private("example.com");
    expect_private("1.2.3");            /* lwIP's aton would read this as 1.2.0.3 */
    expect_private("1.2.3.4.5");
    expect_private("256.1.1.1");
    expect_private("1.2.3.4 ");
    expect_private(" 1.2.3.4");
    expect_private("1.2.3.-4");
    expect_private("1.2.3.4/8");
    expect_private("1..2.3");
    expect_private("....");
    /* Leading zeros and 0x are ambiguous: decimal here, octal/hex in lwIP's
     * ip4addr_aton. 0177.0.0.1 would be 177.0.0.1 (public) read one way and
     * 127.0.0.1 (loopback) read the other, so it must not parse. */
    expect_private("0177.0.0.1");
    expect_private("010.0.0.1");
    expect_private("192.168.01.1");
    expect_private("0x7f.0.0.1");
    expect_private("2130706433");
    /* Nothing crashes on a NULL. */
    expect_private(NULL);
}

/* --------------------------------------------------------------------- */
/* IPv6 classification                                                     */

static void test_ipv6_private(void)
{
    expect_private("::");
    expect_private("::1");
    expect_private("0:0:0:0:0:0:0:1");
    expect_private("fc00::1");          /* ULA */
    expect_private("fd12:3456::1");
    expect_private("fe80::1");          /* link-local */
    expect_private("febf:ffff::1");     /* fe80::/10 top edge */
    expect_private("ff02::1");          /* multicast */
    expect_private("ff00::");
    /* IPv4-mapped and the deprecated IPv4-compatible form both carry an IPv4
     * address in the low 32 bits. ::127.0.0.1 once passed as "public". */
    expect_private("::ffff:127.0.0.1");
    expect_private("::ffff:192.168.1.1");
    expect_private("::127.0.0.1");
    expect_private("::192.168.1.1");
    expect_private("::10.0.0.1");
    /* NAT64: another wrapper around an IPv4 destination. */
    expect_private("64:ff9b::192.168.1.1");
    expect_private("64:ff9b::10.0.0.1");
}

static void test_ipv6_public(void)
{
    expect_public("2001:4860:4860::8888");
    expect_public("2606:4700:4700::1111");
    expect_public("2001:db8::1");       /* documentation range, but not private */
    expect_public("::ffff:8.8.8.8");
    expect_public("::8.8.8.8");
    expect_public("64:ff9b::8.8.8.8");
    expect_public("fbff::1");           /* one below fc00::/7 */
    expect_public("fe00::1");           /* below fe80::/10 */
    expect_public("fec0::1");           /* site-local: deprecated, not in the list */
}

static void test_ipv6_malformed_is_private(void)
{
    expect_private(":");
    expect_private(":::");
    expect_private(":1");
    expect_private("1:");
    expect_private("1:2:3:4:5:6:7");            /* too few groups, no "::" */
    expect_private("1:2:3:4:5:6:7:8:9");        /* too many */
    expect_private("1::2::3");                  /* two "::" runs */
    expect_private("1:2:3:4:5:6:7:8::");        /* "::" standing for nothing */
    expect_private("12345::1");                 /* five hex digits */
    expect_private("gggg::1");
    expect_private("fe80::1%eth0");             /* zone id: not parsed => private */
    expect_private("[::1]");                    /* brackets belong to the URL */
    expect_private("::ffff:999.1.1.1");
    expect_private("::ffff:1.2.3");
}

/* --------------------------------------------------------------------- */
/* URL parsing                                                             */

static void expect_url(const char *url, const char *want_host, int want_port)
{
    char host[FOS_NETGUARD_HOST_LEN];
    int port = -1;
    g_checks++;
    const bool ok = fos_netguard_parse_url(url, host, sizeof(host), &port);
    if (!ok || strcmp(host, want_host) != 0 || port != want_port) {
        g_failures++;
        printf("FAIL parse %-52s got ok=%d host=%s port=%d, want %s:%d\n",
               url, (int)ok, host, port, want_host, want_port);
    }
}

static void expect_url_rejected(const char *url)
{
    char host[FOS_NETGUARD_HOST_LEN];
    int port = -1;
    g_checks++;
    if (fos_netguard_parse_url(url, host, sizeof(host), &port)) {
        g_failures++;
        printf("FAIL parse %-52s accepted as %s:%d, want rejected\n", url, host, port);
    }
}

static void test_url_parser(void)
{
    expect_url("http://example.com/", "example.com", 80);
    expect_url("https://example.com/", "example.com", 443);
    expect_url("HTTP://Example.COM/x", "Example.COM", 80);
    expect_url("https://example.com:8443/a/b?c=d#e", "example.com", 8443);
    expect_url("http://192.168.1.1", "192.168.1.1", 80);
    expect_url("http://example.com:/path", "example.com", 80); /* empty port */
    expect_url("http://[::1]/", "::1", 80);
    expect_url("http://[fe80::1]:8080/x", "fe80::1", 8080);
    expect_url("http://example.com?q=1", "example.com", 80);
    expect_url("http://example.com#frag", "example.com", 80);
    expect_url("http://host:65535/", "host", 65535);

    /* Userinfo. http://example.com@192.168.1.1/ is a request to the LAN
     * address; a parser that stops at the first '@'-free token gets this
     * backwards and hands an SSRF straight through. */
    expect_url("http://example.com@192.168.1.1/", "192.168.1.1", 80);
    expect_url("http://user:pass@10.0.0.5:8080/x", "10.0.0.5", 8080);
    expect_url("http://a@b@127.0.0.1/", "127.0.0.1", 80);

    expect_url_rejected(NULL);
    expect_url_rejected("");
    expect_url_rejected("example.com");           /* no scheme */
    expect_url_rejected("ftp://example.com/");
    expect_url_rejected("file:///etc/passwd");
    expect_url_rejected("http://");
    expect_url_rejected("http:///path");          /* empty host */
    expect_url_rejected("http://@/x");
    expect_url_rejected("http://host:99999/");    /* port out of range */
    expect_url_rejected("http://host:0/");
    expect_url_rejected("http://host:80x/");
    expect_url_rejected("http://::1/");           /* unbracketed IPv6 */
    expect_url_rejected("http://[::1/");          /* unterminated bracket */
    expect_url_rejected("http://[::1]x/");
}

/* --------------------------------------------------------------------- */
/* The policy as a whole                                                   */

static void expect_allowed(const char *url)
{
    char reason[128] = "";
    g_checks++;
    if (!fos_netguard_url_allowed(url, reason, sizeof(reason))) {
        g_failures++;
        printf("FAIL allow  %-52s blocked: %s\n", url, reason);
    }
}

static void expect_blocked(const char *url, const char *want_reason_fragment)
{
    char reason[128] = "";
    g_checks++;
    if (fos_netguard_url_allowed(url, reason, sizeof(reason))) {
        g_failures++;
        printf("FAIL block  %-52s allowed\n", url);
    } else if (strstr(reason, want_reason_fragment) == NULL) {
        g_failures++;
        printf("FAIL block  %-52s reason=\"%s\", want it to mention \"%s\"\n",
               url, reason, want_reason_fragment);
    }
}

static void test_policy_off_allows_everything(void)
{
    fos_netguard_set_policy(false);
    fos_netguard_clear_exempt();
    CHECK(!fos_netguard_policy_active(), "policy should be off");
    expect_allowed("http://192.168.1.1/admin");
    expect_allowed("http://127.0.0.1:8989/api");
    expect_allowed("ftp://192.168.1.1/");   /* not our business when off */
    expect_allowed("nonsense");
}

static void test_policy_on_blocks_literals(void)
{
    fos_netguard_set_policy(true);
    fos_netguard_clear_exempt();
    CHECK(fos_netguard_policy_active(), "policy should be on");

    expect_blocked("http://192.168.1.1/admin", "private");
    expect_blocked("http://10.0.0.1:8080/", "private");
    expect_blocked("http://127.0.0.1:8989/api", "private");
    expect_blocked("http://[::1]:3000/", "private");
    expect_blocked("http://[fd00::1]/", "private");
    expect_blocked("http://[::ffff:192.168.0.1]/", "private");
    expect_blocked("http://169.254.169.254/latest/meta-data/", "private");
    /* The userinfo trick again, this time end to end. */
    expect_blocked("http://example.com@192.168.1.1/", "private");
    /* Ambiguous numerics never reach the resolver. */
    expect_blocked("http://0177.0.0.1/", "well-formed");
    expect_blocked("http://127.1/", "well-formed");
    /* Not an http(s) URL at all. */
    expect_blocked("ftp://192.168.1.1/", "http(s)");
    expect_blocked("gopher://8.8.8.8/", "http(s)");

    expect_allowed("http://8.8.8.8/");
    expect_allowed("https://93.184.216.34/x");
    expect_allowed("http://[2001:4860:4860::8888]/");
}

static void test_exemptions(void)
{
    fos_netguard_set_policy(true);
    fos_netguard_clear_exempt();

    /* The provider's own endpoint — a dev provider on the LAN is exactly the
     * case this exists for. */
    CHECK(fos_netguard_set_exempt("10.4.0.47", 8989), "exempt should be stored");
    expect_allowed("http://10.4.0.47:8989/api/frames/enroll");
    expect_blocked("http://10.4.0.47:8990/api", "private");   /* other port */
    expect_blocked("http://10.4.0.48:8989/api", "private");   /* other host */

    /* Case-insensitive on the host, like the native build's lowercase list. */
    fos_netguard_clear_exempt();
    CHECK(fos_netguard_set_exempt("Dev.Example.COM", 8787), "exempt should be stored");
    expect_allowed("http://dev.example.com:8787/api");
    expect_allowed("http://DEV.EXAMPLE.com:8787/api");

    /* port <= 0 exempts every port on the host. */
    fos_netguard_clear_exempt();
    CHECK(fos_netguard_set_exempt("192.168.7.7", 0), "exempt should be stored");
    expect_allowed("http://192.168.7.7/");
    expect_allowed("http://192.168.7.7:9000/");

    /* The list is bounded and rejects what does not fit; a refused entry must
     * never silently widen the policy. */
    fos_netguard_clear_exempt();
    for (int i = 0; i < FOS_NETGUARD_EXEMPT_MAX; i++) {
        char host[32];
        snprintf(host, sizeof(host), "10.0.0.%d", i + 1);
        CHECK(fos_netguard_set_exempt(host, 80), "entry %d should fit", i);
    }
    CHECK(!fos_netguard_set_exempt("10.0.0.99", 80), "the list should be full");
    expect_blocked("http://10.0.0.99/", "private");
    CHECK(!fos_netguard_set_exempt(NULL, 80), "NULL host must be refused");
    CHECK(!fos_netguard_set_exempt("", 80), "empty host must be refused");

    fos_netguard_clear_exempt();
    expect_blocked("http://10.0.0.1/", "private");
}

static void test_name_resolution(void)
{
    /* The one name every host resolves, and it resolves to loopback: enough to
     * prove the getaddrinfo path classifies what it gets back rather than
     * waving names through. Nothing else here touches DNS — a test suite that
     * needs the internet is a test suite that fails on a train. */
    fos_netguard_set_policy(true);
    fos_netguard_clear_exempt();
    expect_blocked("http://localhost:8989/api", "resolve");

    /* ...and an exemption still wins over resolution, which is what keeps a
     * dev provider on `http://localhost:8989` reachable. */
    CHECK(fos_netguard_set_exempt("localhost", 8989), "exempt should be stored");
    expect_allowed("http://localhost:8989/api");
    expect_blocked("http://localhost:9999/api", "resolve");
}

int main(void)
{
    test_ipv4_private_ranges();
    test_ipv4_public_and_edges();
    test_unparseable_is_private();
    test_ipv6_private();
    test_ipv6_public();
    test_ipv6_malformed_is_private();
    test_url_parser();
    test_policy_off_allows_everything();
    test_policy_on_blocks_literals();
    test_exemptions();
    test_name_resolution();

    /* Leave the guard off: a test binary is not a cloud-managed frame. */
    fos_netguard_set_policy(false);
    fos_netguard_clear_exempt();

    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
