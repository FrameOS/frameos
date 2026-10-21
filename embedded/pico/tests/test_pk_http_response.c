// The streaming response reader, fed the way TCP feeds it: in arbitrary
// slices, down to one byte at a time.
#include <stdlib.h>

#include "pk_http_response.h"
#include "pk_test.h"

typedef struct {
    char data[4096];
    size_t len;
    size_t abort_after; // 0 = never
} collect_t;

static bool collect(void *arg, const uint8_t *data, size_t len)
{
    collect_t *out = arg;
    memcpy(out->data + out->len, data, len);
    out->len += len;
    out->data[out->len] = '\0';
    return out->abort_after == 0 || out->len < out->abort_after;
}

// Feeds `text` in slices of `slice` bytes; returns the final progress.
static pk_http_progress_t feed(pk_http_response_t *response, collect_t *out, const char *text, size_t len,
                               size_t slice)
{
    memset(out, 0, sizeof(*out));
    pk_http_response_init(response, collect, out);
    pk_http_progress_t progress = PK_HTTP_READING;
    for (size_t at = 0; at < len && progress == PK_HTTP_READING; at += slice) {
        size_t take = len - at < slice ? len - at : slice;
        progress = pk_http_response_feed(response, (const uint8_t *)text + at, take);
    }
    return progress;
}

static pk_http_response_t s_response;
static collect_t s_out;

static void test_content_length(void)
{
    const char *text = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                       "content-length: 12\r\nETag: \"abc123\"\r\n\r\nFOSB\x01\x07payload";
    size_t len = strlen(text);
    for (size_t slice = 1; slice <= len; slice++) {
        CHECK(feed(&s_response, &s_out, text, len, slice) == PK_HTTP_DONE);
        CHECK(s_response.status == 200);
        CHECK(s_out.len == 12 && memcmp(s_out.data, "FOSB\x01\x07payload", 12) == 0);
        CHECK_STR(s_response.etag, "\"abc123\"");
        CHECK(s_response.retry_after == -1);
    }
    // Done at the last body byte — no waiting for a keep-alive peer to close
    // — and bytes after it (a pipelined response) are not delivered.
    char extra[256];
    snprintf(extra, sizeof(extra), "%sHTTP/1.1 500 Oops\r\n\r\n", text);
    CHECK(feed(&s_response, &s_out, extra, strlen(extra), 7) == PK_HTTP_DONE);
    CHECK(s_out.len == 12);
}

static void test_chunked(void)
{
    // What a reverse proxy in front of the backend sends.
    const char *text = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 999\r\n\r\n"
                       "4\r\nFOSB\r\n"
                       "A;ext=1\r\n0123456789\r\n"
                       "0\r\nX-Trailer: a-long-trailer-value-that-overflows-the-size-line-buffer\r\n\r\n";
    size_t len = strlen(text);
    for (size_t slice = 1; slice <= len; slice += (slice < 8 ? 1 : 13)) {
        CHECK(feed(&s_response, &s_out, text, len, slice) == PK_HTTP_DONE);
        CHECK_STR(s_out.data, "FOSB0123456789"); // chunked wins over a stray Content-Length
        CHECK(s_response.body_bytes == 14);
    }
    const char *bad_size = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n";
    CHECK(feed(&s_response, &s_out, bad_size, strlen(bad_size), 3) == PK_HTTP_MALFORMED);
    const char *truncated = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\nFOSB";
    CHECK(feed(&s_response, &s_out, truncated, strlen(truncated), 5) == PK_HTTP_READING);
    CHECK(!pk_http_response_eof(&s_response)); // the peer closed mid-chunk: not whole
}

static void test_statuses(void)
{
    // 304 to a conditional settings pull: complete with no body.
    const char *not_modified = "HTTP/1.1 304 Not Modified\r\nETag: \"same\"\r\n\r\n";
    CHECK(feed(&s_response, &s_out, not_modified, strlen(not_modified), 4) == PK_HTTP_DONE);
    CHECK(s_response.status == 304 && s_out.len == 0);
    CHECK_STR(s_response.etag, "\"same\"");

    // 503 from a full render queue: the body is not the sink's business.
    const char *busy = "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 9\r\n\r\nqueue full";
    CHECK(feed(&s_response, &s_out, busy, strlen(busy), 6) == PK_HTTP_DONE);
    CHECK(s_response.status == 503 && s_response.retry_after == 5);
    CHECK(s_out.len == 0 && s_response.body_bytes == 9);
    const char *dated = "HTTP/1.1 503 x\r\nRetry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\nContent-Length: 0\r\n\r\n";
    CHECK(feed(&s_response, &s_out, dated, strlen(dated), 50) == PK_HTTP_DONE);
    CHECK(s_response.retry_after == -1); // the date form is ignored, not misread

    // No length at all (HTTP/1.0 style): whole only once the peer closes.
    const char *until_close = "HTTP/1.0 200 OK\r\n\r\nstream until close";
    CHECK(feed(&s_response, &s_out, until_close, strlen(until_close), 9) == PK_HTTP_READING);
    CHECK_STR(s_out.data, "stream until close");
    CHECK(pk_http_response_eof(&s_response));

    // A short read of a Content-Length body is a truncation.
    const char *short_body = "HTTP/1.1 200 OK\r\nContent-Length: 192012\r\n\r\nFOSB";
    CHECK(feed(&s_response, &s_out, short_body, strlen(short_body), 10) == PK_HTTP_READING);
    CHECK(!pk_http_response_eof(&s_response));
}

static void test_bad_and_abort(void)
{
    static const char *const malformed[] = {
        "SSH-2.0-OpenSSH_9.6\r\n\r\n", "HTTP/1.1 OK\r\n\r\n", "HTTP/1.1 2x0 OK\r\n\r\n", "HTTP/2 200\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: -5\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 99999999999\r\n\r\n",
    };
    for (size_t i = 0; i < sizeof(malformed) / sizeof(malformed[0]); i++) {
        CHECK(feed(&s_response, &s_out, malformed[i], strlen(malformed[i]), 5) == PK_HTTP_MALFORMED);
    }
    // A header block that never ends is cut off, not buffered forever.
    char *endless = malloc(PK_HTTP_HEADER_MAX * 2);
    memset(endless, 'h', PK_HTTP_HEADER_MAX * 2);
    memcpy(endless, "HTTP/1.1 200 OK\r\nX: ", 20);
    CHECK(feed(&s_response, &s_out, endless, PK_HTTP_HEADER_MAX * 2, 100) == PK_HTTP_MALFORMED);
    free(endless);

    // The sink refusing (payload does not match the panel) stops the transfer.
    const char *text = "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n01234567890123456789";
    memset(&s_out, 0, sizeof(s_out));
    pk_http_response_init(&s_response, collect, &s_out);
    s_out.abort_after = 5;
    pk_http_progress_t progress = PK_HTTP_READING;
    for (size_t at = 0; at < strlen(text) && progress == PK_HTTP_READING; at += 3) {
        size_t take = strlen(text) - at < 3 ? strlen(text) - at : 3;
        progress = pk_http_response_feed(&s_response, (const uint8_t *)text + at, take);
    }
    CHECK(progress == PK_HTTP_SINK_ABORTED);
    CHECK(s_out.len < 20);
    CHECK(!pk_http_response_eof(&s_response));
}

int main(void)
{
    test_content_length();
    test_chunked();
    test_statuses();
    test_bad_and_abort();
    return pk_test_result("test_pk_http_response");
}
