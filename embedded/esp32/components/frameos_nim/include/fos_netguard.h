/*
 * Private-network egress policy for scene HTTP.
 *
 * docs/cloud-frames.md: scenes installed by a cloud provider run *inside the
 * owner's LAN*, so on a cloud-managed frame HTTP to private/link-local
 * addresses is denied — otherwise a compromised provider account (or a
 * malicious JS app pushed through one) turns every frame into an SSRF pivot
 * onto routers, NAS boxes and IoT devices that trust anything on the wire.
 *
 * The native (Pi/Linux) build has had this since the cloud link shipped, in
 * frameos/src/frameos/utils/http_client.nim (isPrivateNetworkAddress /
 * enforceLocalNetworkPolicy). The ESP32 firmware does its scene HTTP in C
 * through esp_http_client and so had no check at any layer. This module is the
 * port; keep the two classifiers in step.
 *
 * Everything except fos_netguard_url_allowed()'s DNS fallback is pure C over
 * strings with no IDF and no lwip dependency, so the classifier and the URL
 * parser compile and are tested on the host — see main/tests/test_fos_netguard.c.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* How many "host:port" exemptions the policy holds. Two is the real need (the
 * provider's API endpoint plus a dev frame-hub on another port); four leaves
 * room without putting a meaningful array on a caller's stack. */
#define FOS_NETGUARD_EXEMPT_MAX 4
/* Longest exempted host kept. A hostname longer than this simply does not get
 * exempted — it never lets an extra address through. */
#define FOS_NETGUARD_EXEMPT_HOST_LEN 96
/* Buffer a caller must give fos_netguard_parse_url() for the host. A DNS name
 * is at most 253 characters; anything longer is not a host we can check, and
 * parsing fails (which blocks) rather than truncating (which would check the
 * wrong name). */
#define FOS_NETGUARD_HOST_LEN 256

/* Turn the deny on or off. Off (the default) is the standalone /
 * backend-managed frame: the owner's own scenes may talk to the owner's LAN. */
void fos_netguard_set_policy(bool block_local);

/* True when the deny is currently active. */
bool fos_netguard_policy_active(void);

/* Drop every exemption. Call before re-adding, so the list always describes
 * the provider we are enrolled with right now. */
void fos_netguard_clear_exempt(void);

/* Keep `host:port` reachable while the deny is active. The local admin linked
 * this provider deliberately — possibly a dev provider on the LAN — so its own
 * endpoint must not be collateral damage. `port` <= 0 means "any port on this
 * host". Matching is case-insensitive on the host, exactly like the native
 * build's lowercase "host:port" exempt list. Returns false when the list is
 * full or the entry does not fit. */
bool fos_netguard_set_exempt(const char *host, int port);

/* Is `ip` (a bare IPv4 or IPv6 literal, no brackets, no port) an address a
 * cloud-installed scene must not reach? Covers loopback, RFC1918, link-local,
 * CGNAT, 0/8, multicast, reserved — and the IPv6 equivalents including the
 * wrappers that carry an IPv4 address (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96).
 *
 * Unparseable input is PRIVATE. The caller is about to hand the string to
 * connect(), so failing closed is the only safe answer; the Nim version does
 * the same and this is load-bearing, not defensive noise. */
bool fos_netguard_is_private_ip(const char *ip);

/* Split "scheme://[user:pass@]host[:port][/path]" into a bare host (IPv6
 * literals unbracketed) and a port, defaulting 80/443 from the scheme.
 * Returns false for anything that is not an http:// or https:// URL with a
 * host — callers treat that as a block, not as "no host to check".
 *
 * Exposed for the host tests: userinfo is where URL parsers traditionally get
 * this wrong, and http://example.com@192.168.1.1/ must resolve to the LAN
 * address, not to example.com. */
bool fos_netguard_parse_url(const char *url, char *host, size_t host_len, int *port);

/* The check the HTTP client calls, once per hop (initial request and every
 * redirect). Returns true when the request may proceed: the policy is off, the
 * host:port is exempt, or every address the host resolves to is public.
 *
 * A host given as an IP literal is classified directly. A name is resolved
 * with getaddrinfo() and rejected if ANY returned address is private — a
 * DNS-rebinding answer that mixes one public and one RFC1918 record must not
 * pass, and the connect() that follows picks whichever it likes.
 *
 * On a block, `reason` (when non-NULL) gets a short human-readable phrase for
 * the error surfaced to the scene. */
bool fos_netguard_url_allowed(const char *url, char *reason, size_t reason_len);

#ifdef __cplusplus
}
#endif
