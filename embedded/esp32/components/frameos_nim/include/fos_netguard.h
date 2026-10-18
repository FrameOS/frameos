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
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct addrinfo;

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

/* The three answers a URL can get while the deny is active. UNRESOLVED is a
 * DNS failure, not a policy decision: the request cannot proceed (connect()
 * would resolve the name again, which is the rebinding hole the check
 * exists to close), but the scene should hear "could not resolve", the same
 * words the Pi's client uses, not "blocked" - a public host that failed to
 * resolve once after a wake from deep sleep is not the owner's router. */
typedef enum {
    FOS_NETGUARD_ALLOWED = 0,
    FOS_NETGUARD_BLOCKED,
    FOS_NETGUARD_UNRESOLVED,
} fos_netguard_verdict_t;

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
fos_netguard_verdict_t fos_netguard_check_url(const char *url, char *reason, size_t reason_len);

/* fos_netguard_check_url() == FOS_NETGUARD_ALLOWED. */
bool fos_netguard_url_allowed(const char *url, char *reason, size_t reason_len);

/* What an ALLOWED verdict for a host NAME was decided on. The connect that
 * follows must go to exactly this address and not resolve the name again: a
 * second answer can be a router address the first one was not (DNS
 * rebinding, a TTL-0 record answering public, then private), and ESP-IDF
 * resolves the URL's host itself when it connects. frameos_nim_glue.c holds
 * the pin for the calling task across esp_http_client_open() and answers
 * lwIP's resolve hook from it. `active` is false when there is nothing to
 * pin: the policy is off, or the host is an IP literal or exempt. */
typedef struct {
    bool active;
    uint32_t host_hash; /* fos_netguard_host_hash() of the name */
    uint8_t v4[4];
} fos_netguard_pin_t;

/* fos_netguard_check_url(), and with the policy on, the pin for a name it
 * resolved. A name that answers with no IPv4 address is UNRESOLVED here:
 * the frame connects over IPv4 only, so there is nothing safe to pin. */
fos_netguard_verdict_t fos_netguard_check_url_pinned(const char *url, char *reason,
                                                     size_t reason_len, fos_netguard_pin_t *pin);

/* Hold `pin` for the calling task until fos_netguard_unpin_for_task(): while
 * it is held, lwIP's resolve hook answers the pinned name on this task with
 * the pinned address (CONFIG_LWIP_HOOK_NETCONN_EXT_RESOLVE_CUSTOM). True for
 * an inactive pin (nothing to hold); false when every slot is taken, which
 * the caller must treat as a refusal. Device builds only. */
bool fos_netguard_pin_for_task(const fos_netguard_pin_t *pin);
void fos_netguard_unpin_for_task(void);

/* The same check for the frame's own fetch of a URL someone else chose (the
 * OTA manifest's off-origin downloadUrl): every address must be public,
 * whatever the scene policy says, and no exemption applies. On ALLOWED for a
 * name, `pin` holds the checked address. */
fos_netguard_verdict_t fos_netguard_check_public_url(const char *url, char *reason,
                                                     size_t reason_len, fos_netguard_pin_t *pin);

/* A host name's identity for the pin: FNV-1a over the name, ASCII lowercased.
 * Two names that collide can only ever get an address that was checked as
 * public, never a private one. */
uint32_t fos_netguard_host_hash(const char *host);

#ifndef ESP_PLATFORM
/* Host tests: answer names without DNS. NULL restores getaddrinfo(). */
void fos_netguard_set_test_getaddrinfo(int (*fn)(const char *node, const char *service,
                                                 const struct addrinfo *hints,
                                                 struct addrinfo **res));
#endif

/* The error a scene gets for a FOS_NETGUARD_BLOCKED request, the same
 * sentence on both runtimes: the first %s is "" or "redirect: " (the hop that
 * was refused), the second the reason. The prefix is what the SPA matches to
 * offer a link to the setting, the last sentence is what the owner acts on:
 * the glue's buffers are sized so neither is ever cut. */
#define FOS_NETGUARD_BLOCK_FMT \
    "Local network access is off for this frame (%s%s). Turn on local network access in the frame settings."

#ifdef __cplusplus
}
#endif
