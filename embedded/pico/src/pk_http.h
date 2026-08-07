// Minimal streaming HTTP/1.1 GET client over lwIP (plain TCP).
//
// Small on purpose: lwIP's bundled http client cannot send custom headers,
// and the thin client needs `Authorization: Bearer`. The response body is
// delivered in chunks to a sink callback as it arrives — nothing larger
// than a TCP segment is ever buffered, which is what lets an RP2040 with
// 264KB of SRAM drive a 192KB panel payload.
//
// v1 is deliberately http:// only (the self-hosted backend on the LAN).
// TLS via pico mbedTLS is a follow-up; until then https:// URLs are
// refused up front at provisioning time rather than failing mid-fetch.
#ifndef PK_HTTP_H
#define PK_HTTP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef bool (*pk_http_sink_fn)(void *arg, const uint8_t *data, size_t len);

typedef struct {
    const char *url;          // http://host[:port]/path
    const char *bearer_token; // optional Authorization: Bearer value
    uint32_t timeout_ms;      // whole-request deadline
    pk_http_sink_fn sink;     // called per body chunk; false aborts
    void *sink_arg;
} pk_http_request_t;

typedef struct {
    int status;               // HTTP status, or <0 on transport error
    size_t body_bytes;        // body bytes delivered to the sink
    bool sink_aborted;
} pk_http_result_t;

bool pk_http_url_is_supported(const char *url);
pk_http_result_t pk_http_get(const pk_http_request_t *request);

#endif // PK_HTTP_H
