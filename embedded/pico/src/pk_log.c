#include "pk_log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "pk_json.h"

typedef struct {
    uint32_t seq; // 0 = empty slot
    uint32_t epoch;
    bool json;
    char line[PK_LOG_LINE_MAX];
} pk_log_entry_t;

static pk_log_entry_t s_entries[PK_LOG_SLOTS];
static uint32_t s_next_seq = 1;
static uint32_t s_uploaded_seq = 0;
static pk_log_clock_fn s_clock = NULL;
static pk_log_sink_fn s_console = NULL;

void pk_log_init(pk_log_clock_fn clock, pk_log_sink_fn console)
{
    memset(s_entries, 0, sizeof(s_entries));
    s_next_seq = 1;
    s_uploaded_seq = 0;
    s_clock = clock;
    s_console = console;
}

static uint32_t oldest_seq(void)
{
    return s_next_seq > PK_LOG_SLOTS ? s_next_seq - PK_LOG_SLOTS : 1;
}

static void push(const char *line, bool json)
{
    pk_log_entry_t *entry = &s_entries[s_next_seq % PK_LOG_SLOTS];
    entry->seq = s_next_seq++;
    entry->epoch = s_clock ? s_clock() : 0;
    entry->json = json;
    snprintf(entry->line, sizeof(entry->line), "%s", line);
    if (s_console) s_console(entry->line);
}

void pk_logf(const char *fmt, ...)
{
    char line[PK_LOG_LINE_MAX];
    va_list args;
    va_start(args, fmt);
    vsnprintf(line, sizeof(line), fmt, args);
    va_end(args);
    // One entry per line keeps the dump format parseable.
    for (char *p = line; *p; p++) {
        if (*p == '\n' || *p == '\r') *p = ' ';
    }
    push(line, false);
}

void pk_log_event(const char *json)
{
    size_t len = json ? strlen(json) : 0;
    // A truncated object would poison the whole upload batch: what does not
    // fit travels as a plain (escaped) message instead.
    bool whole = len >= 2 && len < PK_LOG_LINE_MAX && json[0] == '{' && json[len - 1] == '}' &&
                 strchr(json, '\n') == NULL;
    if (whole) {
        push(json, true);
    } else {
        pk_logf("%s", json ? json : "");
    }
}

void pk_log_dump(pk_log_write_fn write, void *arg)
{
    for (uint32_t seq = oldest_seq(); seq < s_next_seq; seq++) {
        const pk_log_entry_t *entry = &s_entries[seq % PK_LOG_SLOTS];
        if (entry->seq != seq) continue;
        char stamp[16];
        int stamp_len = entry->epoch ? snprintf(stamp, sizeof(stamp), "%lu ", (unsigned long)entry->epoch)
                                     : snprintf(stamp, sizeof(stamp), "- ");
        write(arg, stamp, (size_t)stamp_len);
        write(arg, entry->line, strlen(entry->line));
        write(arg, "\n", 1);
    }
}

bool pk_log_upload_pending(void)
{
    return s_uploaded_seq + 1 < s_next_seq;
}

// Appends one entry as a JSON object; false (and nothing written) when it
// does not fit in the remaining room, which always keeps space for "]}".
static bool append_entry(char *out, size_t cap, size_t *len, const pk_log_entry_t *entry, bool first)
{
    static const char prefix[] = "{\"event\":\"log\",\"source\":\"pico\",\"message\":\"";
    size_t start = *len;
    size_t room = cap - 3; // "]}" + NUL
    if (!first) {
        if (*len + 1 > room) return false;
        out[(*len)++] = ',';
    }
    size_t line_len = strlen(entry->line);
    if (entry->json) {
        if (*len + line_len > room) goto rollback;
        memcpy(out + *len, entry->line, line_len);
        *len += line_len;
        return true;
    }
    if (*len + sizeof(prefix) - 1 + pk_json_escaped_len(entry->line) + 2 > room) goto rollback;
    memcpy(out + *len, prefix, sizeof(prefix) - 1);
    *len += sizeof(prefix) - 1;
    *len += pk_json_escape(entry->line, out + *len, room - *len);
    out[(*len)++] = '"';
    out[(*len)++] = '}';
    return true;
rollback:
    *len = start;
    return false;
}

size_t pk_log_build_batch(char *out, size_t cap, uint32_t *cursor)
{
    if (out == NULL || cursor == NULL || cap < 128 || !pk_log_upload_pending()) return 0;
    uint32_t first_seq = s_uploaded_seq + 1;
    uint32_t dropped = 0;
    if (first_seq < oldest_seq()) {
        dropped = oldest_seq() - first_seq;
        first_seq = oldest_seq();
    }

    size_t len = (size_t)snprintf(out, cap, "{\"logs\":[");
    bool first = true;
    if (dropped > 0) {
        len += (size_t)snprintf(out + len, cap - len,
                                "{\"event\":\"log:dropped\",\"source\":\"pico\",\"count\":%lu}",
                                (unsigned long)dropped);
        first = false;
    }
    uint32_t last = first_seq - 1;
    for (uint32_t seq = first_seq; seq < s_next_seq; seq++) {
        const pk_log_entry_t *entry = &s_entries[seq % PK_LOG_SLOTS];
        if (entry->seq != seq) continue;
        if (!append_entry(out, cap, &len, entry, first)) break;
        first = false;
        last = seq;
    }
    if (first) return 0; // not even one entry fits
    out[len++] = ']';
    out[len++] = '}';
    out[len] = '\0';
    *cursor = last;
    return len;
}

void pk_log_mark_uploaded(uint32_t cursor)
{
    if (cursor > s_uploaded_seq && cursor < s_next_seq) s_uploaded_seq = cursor;
}
