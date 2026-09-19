// An incremental HTTP/1.1 response reader for the streaming client
// (pk_http.c): feed it TCP segments as they arrive and it hands the body to a
// sink, never holding more than the header block. It knows when the response
// is complete — Content-Length reached, or the last chunk of a
// `Transfer-Encoding: chunked` body (what a reverse proxy in front of the
// backend sends) — so the client does not depend on the server closing the
// connection. Portable, host-tested (tests/test_pk_http_response.c).
#ifndef PK_HTTP_RESPONSE_H
#define PK_HTTP_RESPONSE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PK_HTTP_HEADER_MAX 1536
#define PK_HTTP_ETAG_MAX 96

// Receives body bytes of a 200 response; false aborts the transfer.
typedef bool (*pk_http_sink_fn)(void *arg, const uint8_t *data, size_t len);

typedef enum {
    PK_HTTP_READING = 0,
    PK_HTTP_DONE,        // complete response received
    PK_HTTP_MALFORMED,
    PK_HTTP_SINK_ABORTED,
} pk_http_progress_t;

typedef struct {
    pk_http_sink_fn sink;
    void *sink_arg;

    // Results, valid once the headers are in (status != 0).
    int status;
    char etag[PK_HTTP_ETAG_MAX];
    long retry_after;     // seconds, -1 when absent
    size_t body_bytes;    // decoded body bytes seen (any status)

    // Internals.
    char header[PK_HTTP_HEADER_MAX];
    size_t header_len;
    bool headers_done;
    bool chunked;
    bool has_length;
    size_t remaining;     // of the body (identity) or of the current chunk
    int chunk_state;
    char chunk_line[20];
    size_t chunk_line_len;
    pk_http_progress_t progress;
} pk_http_response_t;

void pk_http_response_init(pk_http_response_t *response, pk_http_sink_fn sink, void *sink_arg);
pk_http_progress_t pk_http_response_feed(pk_http_response_t *response, const uint8_t *data, size_t len);
// The peer closed: complete for a body that had no length, a truncation
// otherwise. Returns true when the response can be trusted as whole.
bool pk_http_response_eof(pk_http_response_t *response);

#endif // PK_HTTP_RESPONSE_H
