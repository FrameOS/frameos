/*
 * One HTTP client for the firmware's small pulls and posts.
 *
 * The settings pull, the scenes pull, the commands pull, the tz slice lookup
 * and the OTA manifest all used to set up esp_http_client by hand: the same
 * bearer header, the same optional If-None-Match, the same bounded read into
 * a malloc'd buffer, the same close/cleanup on every exit — five copies, 1 to
 * 2 KB of flash each. This is the one copy. Streams stay out of it: the
 * remote-render bitmap, the OTA image and the image push read or write bodies
 * as they go.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    const char *url;
    const char *auth;          /* the Authorization value ("Bearer …"); NULL = none */
    const char *if_none_match; /* NULL = none */
    const char *body;          /* JSON to POST; NULL = GET */
    bool no_store;             /* Cache-Control: no-store (a body that is credentials) */
    int timeout_ms;            /* 0 = 15 s */
    int buffer_size;           /* esp_http_client's receive buffer; 0 = 2 KB */
} fos_http_request_t;

typedef struct {
    int status;             /* the HTTP status; 0 when no answer came */
    int64_t content_length; /* as declared; -1 = chunked, read to the end */
    bool too_large;         /* the body was over the cap and was not read */
    char etag[96];          /* the response ETag, "" when none */
    char *body;             /* NUL-terminated; NULL when not read. fos_http_response_free() */
    size_t body_len;
} fos_http_response_t;

/* Perform the request. ESP_OK means an answer came (any status, including
 * 304 and 4xx — look at `res->status`); an error means it never did. The body
 * is read into `res->body` when `max_body` > 0 and the answer carries one
 * (not on 304), up to `max_body` bytes: past that it is dropped and
 * `too_large` set. The buffer is PSRAM where the board has it (fos_mem.h),
 * so a scene bundle does not land in internal RAM. */
esp_err_t fos_http_fetch(const fos_http_request_t *req, size_t max_body, fos_http_response_t *res);

/* esp_err_to_name() has no row for esp_http_client's own codes, so a refused
 * connect reached the frame's log as `"espErr":28674,"espErrName":"UNKNOWN
 * ERROR"`. The HTTP range by name; everything else as esp_err_to_name(). */
const char *fos_http_err_name(esp_err_t err);

void fos_http_response_free(fos_http_response_t *res);

/* `{backend_url}/api/frames/{frame_id}{suffix}`; false when no backend is
 * configured. And the bearer value for it. */
bool fos_backend_url(const char *suffix, char *out, size_t out_len);
void fos_backend_auth(char *out, size_t out_len);
