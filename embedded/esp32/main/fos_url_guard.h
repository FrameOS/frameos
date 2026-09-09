/*
 * Provider URL rules, kept as plain C over strings so they can be argued
 * about on a laptop (main/tests/test_fos_url_guard.c): which hosts count as
 * "local" for the plain-transport exception, the http/https and ws/wss
 * transport rule, the stale ws_url override guard, and the origin
 * comparison that keeps the bearer token on the control plane's own host.
 *
 * No IDF, no logging, no globals: the callers in fos_cloud.c / fos_ota.c
 * own the policy decisions and the log lines.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

/* Working-buffer size for host[:port] / origin strings; mirrors FOS_URL_LEN
 * in fos_config.h (asserted equal there). */
#define FOS_URL_GUARD_LEN 256

/* Hosts where a plain (unencrypted) transport is acceptable, because no
 * meaningful third party can sit on the path: localhost, `.local` /
 * `.localhost` names, loopback, RFC1918, link-local and CGNAT literals
 * (dotted quads parsed strictly: no leading zeros, no sign, no whitespace —
 * Python's ipaddress rejects those too, and the backend half of this rule
 * is backend/app/utils/cloud_link.py::_is_local_host). IPv6 literals
 * arrive WITHOUT brackets. Same rule as docs/cloud-link.md. */
bool fos_url_host_is_local(const char *host);

/* Split "scheme://host[:port][/path]" into a secure flag + host[:port].
 * False when the URL has neither the secure nor the plain scheme, or no
 * host. Userinfo ("a@b") is left in the host part and fails the host
 * checks downstream rather than being guessed. */
bool fos_url_split_scheme(const char *url, const char *secure_scheme,
                          const char *plain_scheme, bool *is_secure,
                          char *host, size_t host_len);

/* Strip [] and a single :port so the result is a bare name or literal. */
void fos_url_host_only(const char *hostport, char *out, size_t out_len);

/* The transport rule for both wire shapes: the secure scheme (https / wss)
 * is fine anywhere; the plain one (http / ws) only for hosts
 * fos_url_host_is_local() accepts. `reason` (optional) receives a static
 * string on refusal. */
bool fos_url_transport_ok(const char *url, bool ws, const char **reason);

/* Is this ws_url override plausible for the provider we are enrolled with?
 * A loopback override is only credible when cloud_url is loopback too;
 * anything else is a leftover from a previous life. Empty ws_url: true. */
bool fos_ws_url_matches_provider(const char *ws_url, const char *cloud_url);

/* "scheme://host[:port]" of an http(s)/ws(s) URL, lowercased, with ws
 * mapped onto http so a wss:// ws_url compares equal to the https:// origin
 * it serves. False for any other shape, including userinfo. */
bool fos_url_origin(const char *url, char *out, size_t out_len);

/* Does download_url share an origin with the control plane (base_url) or
 * with the cloud's enrollment ws_url (NULL / "" when there is none)? The
 * frame's bearer goes only to a first-party origin. */
bool fos_url_download_is_first_party(const char *download_url, const char *base_url,
                                     const char *ws_url);
