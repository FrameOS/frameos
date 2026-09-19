// The text half of the device's HTTP server: request parsing, the access
// rule, form decoding. No sockets here — pk_httpd.c owns lwIP — so all of it
// is host-tested (tests/test_pk_httpd_parse.c).
#ifndef PK_HTTPD_PARSE_H
#define PK_HTTPD_PARSE_H

#include <stdbool.h>
#include <stddef.h>

#include "pk_config.h"

#define PK_HTTPD_PATH_MAX 160
#define PK_HTTPD_AUTH_MAX 256

typedef struct {
    char method[8];
    char path[PK_HTTPD_PATH_MAX];  // without the query string
    char authorization[PK_HTTPD_AUTH_MAX];
    size_t content_length;
    size_t body_offset;            // where the body starts in the buffer
} pk_httpd_request_t;

typedef enum {
    PK_HTTPD_INCOMPLETE = 0, // keep reading (headers or body not all here yet)
    PK_HTTPD_READY,
    PK_HTTPD_BAD_REQUEST,
} pk_httpd_parse_t;

// Parses what has arrived so far. READY only once the headers and
// Content-Length bytes of body are all in `buf`.
pk_httpd_parse_t pk_httpd_parse(const char *buf, size_t len, pk_httpd_request_t *out);

// The access rule of the ESP32 server (fos_http.c require_protected_access):
// `Authorization: Bearer <api_key>` (what the backend sends) or, when the
// device login is enabled, `Basic user:pass`. Compared in constant time.
bool pk_httpd_authorized(const pk_httpd_request_t *request, const pk_config_t *config);

// One field of an application/x-www-form-urlencoded body, decoded. False when
// absent or too long for dst.
bool pk_httpd_form_value(const char *body, size_t len, const char *key, char *dst, size_t cap);

// RFC 4648 decode; returns the byte count or -1. dst may equal src.
int pk_base64_decode(const char *src, size_t len, unsigned char *dst, size_t cap);

// Escapes text for an HTML attribute or body. Returns bytes written (no NUL).
size_t pk_html_escape(const char *src, char *dst, size_t cap);

#endif // PK_HTTPD_PARSE_H
