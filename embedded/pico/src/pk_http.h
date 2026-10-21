// Minimal streaming HTTP/1.1 client over lwIP.
//
// Small on purpose: lwIP's bundled http client cannot send custom headers,
// and the thin client needs `Authorization: Bearer`. The response body is
// delivered in chunks to a sink callback as it arrives — nothing larger
// than a TCP segment is ever buffered here, which is what lets an RP2040
// with 264KB of SRAM drive a 192KB panel payload. Response framing
// (Content-Length, chunked, ETag, Retry-After) lives in pk_http_response.c.
//
// Plain http:// talks to a self-hosted backend on the LAN; https:// runs
// TLS 1.2 through pico-sdk's mbedTLS behind lwIP altcp, with hostname
// verification against the embedded root bundle (certs/pk_ca_roots.h), so
// the server is authenticated. See the README's "TLS" section for the
// SNTP / build-time validity floor.
#ifndef PK_HTTP_H
#define PK_HTTP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pk_http_response.h"

typedef struct {
    const char *method;         // "GET" when NULL
    const char *url;            // http(s)://host[:port]/path
    const char *bearer_token;   // optional Authorization: Bearer value
    const char *if_none_match;  // optional ETag for a conditional GET
    const char *content_type;   // with a body
    const char *body;           // optional request body (must fit TCP_SND_BUF)
    size_t body_len;
    uint32_t timeout_ms;        // whole-request deadline
    pk_http_sink_fn sink;       // body of a 200 response, per chunk; false aborts
    void *sink_arg;
} pk_http_request_t;

typedef struct {
    int status;                 // HTTP status, or <0 on transport error
    size_t body_bytes;          // body bytes received
    bool complete;              // the whole response arrived
    bool sink_aborted;
    long retry_after;           // seconds from a Retry-After header, else -1
    char etag[PK_HTTP_ETAG_MAX];
} pk_http_result_t;

pk_http_result_t pk_http_request(const pk_http_request_t *request);

// Convenience: collects a (small) body into `buffer`, NUL-terminated. A body
// that does not fit aborts the transfer and reports sink_aborted.
typedef struct {
    char *data;
    size_t cap;
    size_t len;
} pk_http_buffer_t;
bool pk_http_buffer_sink(void *arg, const uint8_t *data, size_t len);

#endif // PK_HTTP_H
