#include "pk_http_response.h"

#include <stdlib.h>
#include <string.h>

enum { CHUNK_SIZE_LINE = 0, CHUNK_DATA, CHUNK_DATA_END, CHUNK_TRAILERS };

void pk_http_response_init(pk_http_response_t *response, pk_http_sink_fn sink, void *sink_arg)
{
    memset(response, 0, sizeof(*response));
    response->sink = sink;
    response->sink_arg = sink_arg;
    response->retry_after = -1;
}

static char lower(char c)
{
    return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
}

// The value of header `name` (lowercase) in the NUL-terminated header block,
// trimmed, or NULL. *len receives its length.
static const char *header_value(const char *block, const char *name, size_t *len)
{
    size_t name_len = strlen(name);
    const char *line = strstr(block, "\r\n");
    while (line != NULL) {
        line += 2;
        size_t i = 0;
        while (i < name_len && lower(line[i]) == name[i]) i++;
        if (i == name_len && line[i] == ':') {
            const char *value = line + i + 1;
            while (*value == ' ' || *value == '\t') value++;
            const char *end = strstr(value, "\r\n");
            if (end == NULL) end = value + strlen(value);
            while (end > value && (end[-1] == ' ' || end[-1] == '\t')) end--;
            *len = (size_t)(end - value);
            return value;
        }
        line = strstr(line, "\r\n");
    }
    return NULL;
}

static bool parse_headers(pk_http_response_t *r)
{
    // "HTTP/1.1 200 OK"
    const char *h = r->header;
    if (strncmp(h, "HTTP/1.", 7) != 0 || h[7] < '0' || h[7] > '9' || h[8] != ' ') return false;
    int status = 0;
    for (int i = 9; i < 12; i++) {
        if (h[i] < '0' || h[i] > '9') return false;
        status = status * 10 + (h[i] - '0');
    }
    if (status < 100) return false;
    r->status = status;

    size_t len = 0;
    const char *value = header_value(h, "transfer-encoding", &len);
    if (value != NULL) {
        for (size_t i = 0; i + 7 <= len; i++) {
            if (lower(value[i]) == 'c' && strncmp(value + i + 1, "hunked", 6) == 0) r->chunked = true;
        }
    }
    value = header_value(h, "content-length", &len);
    if (value != NULL && !r->chunked) {
        if (len == 0 || len > 10) return false;
        size_t total = 0;
        for (size_t i = 0; i < len; i++) {
            if (value[i] < '0' || value[i] > '9') return false;
            total = total * 10 + (size_t)(value[i] - '0');
        }
        r->has_length = true;
        r->remaining = total;
    }
    value = header_value(h, "etag", &len);
    if (value != NULL && len < sizeof(r->etag)) {
        memcpy(r->etag, value, len);
        r->etag[len] = '\0';
    }
    value = header_value(h, "retry-after", &len);
    if (value != NULL && len > 0 && len < 8 && value[0] >= '0' && value[0] <= '9') {
        r->retry_after = strtol(value, NULL, 10); // the delay form; a date is ignored
    }
    return true;
}

static bool deliver(pk_http_response_t *r, const uint8_t *data, size_t len)
{
    r->body_bytes += len;
    if (r->status == 200 && r->sink != NULL && len > 0) {
        if (!r->sink(r->sink_arg, data, len)) {
            r->progress = PK_HTTP_SINK_ABORTED;
            return false;
        }
    }
    return true;
}

static void feed_chunked(pk_http_response_t *r, const uint8_t *data, size_t len)
{
    size_t i = 0;
    while (i < len && r->progress == PK_HTTP_READING) {
        switch (r->chunk_state) {
            case CHUNK_SIZE_LINE:
            case CHUNK_TRAILERS: {
                char c = (char)data[i++];
                if (c != '\n') {
                    if (c != '\r' && r->chunk_line_len + 1 < sizeof(r->chunk_line)) {
                        r->chunk_line[r->chunk_line_len++] = c;
                    } else if (c != '\r' && r->chunk_state == CHUNK_SIZE_LINE) {
                        r->progress = PK_HTTP_MALFORMED; // a size line is never this long
                    }
                    break;
                }
                r->chunk_line[r->chunk_line_len] = '\0';
                bool blank = r->chunk_line_len == 0;
                r->chunk_line_len = 0;
                if (r->chunk_state == CHUNK_TRAILERS) {
                    if (blank) r->progress = PK_HTTP_DONE;
                    break;
                }
                char *end = NULL;
                unsigned long size = strtoul(r->chunk_line, &end, 16);
                if (blank || end == r->chunk_line || (*end != '\0' && *end != ';' && *end != ' ')) {
                    r->progress = PK_HTTP_MALFORMED;
                    break;
                }
                r->remaining = (size_t)size;
                r->chunk_state = size == 0 ? CHUNK_TRAILERS : CHUNK_DATA;
                break;
            }
            case CHUNK_DATA: {
                size_t take = len - i < r->remaining ? len - i : r->remaining;
                if (!deliver(r, data + i, take)) return;
                i += take;
                r->remaining -= take;
                if (r->remaining == 0) {
                    r->chunk_state = CHUNK_DATA_END;
                    r->remaining = 2; // the CRLF that closes the chunk
                }
                break;
            }
            case CHUNK_DATA_END:
                i++;
                if (--r->remaining == 0) r->chunk_state = CHUNK_SIZE_LINE;
                break;
        }
    }
}

pk_http_progress_t pk_http_response_feed(pk_http_response_t *r, const uint8_t *data, size_t len)
{
    size_t i = 0;
    while (!r->headers_done && i < len && r->progress == PK_HTTP_READING) {
        if (r->header_len + 1 >= sizeof(r->header)) {
            r->progress = PK_HTTP_MALFORMED; // oversized header block
            break;
        }
        r->header[r->header_len++] = (char)data[i++];
        if (r->header_len >= 4 && memcmp(r->header + r->header_len - 4, "\r\n\r\n", 4) == 0) {
            r->header[r->header_len] = '\0';
            r->headers_done = true;
            if (!parse_headers(r)) {
                r->progress = PK_HTTP_MALFORMED;
            } else if (r->status == 204 || r->status == 304 || (r->has_length && r->remaining == 0)) {
                r->progress = PK_HTTP_DONE;
            }
        }
    }
    if (r->progress != PK_HTTP_READING || i >= len) return r->progress;

    if (r->chunked) {
        feed_chunked(r, data + i, len - i);
    } else if (r->has_length) {
        size_t take = len - i < r->remaining ? len - i : r->remaining;
        if (deliver(r, data + i, take)) {
            r->remaining -= take;
            if (r->remaining == 0) r->progress = PK_HTTP_DONE;
        }
    } else {
        deliver(r, data + i, len - i); // length-less body: runs until the peer closes
    }
    return r->progress;
}

bool pk_http_response_eof(pk_http_response_t *r)
{
    if (r->progress == PK_HTTP_DONE) return true;
    if (r->progress == PK_HTTP_READING && r->headers_done && !r->chunked && !r->has_length) {
        r->progress = PK_HTTP_DONE;
        return true;
    }
    return false;
}
