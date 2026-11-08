#pragma once
/* A depth pre-scan for untrusted JSON before it reaches cJSON.
 *
 * cJSON recurses once per nested array/object and only stops at
 * CJSON_NESTING_LIMIT (1000). The tasks that parse peer-supplied JSON here
 * run on 8-10 KB stacks (the WebSocket task, esp_http_server, the console),
 * so a few hundred `[` from an authenticated peer is a stack overflow and a
 * reset, not a parse error. This walks the text once, string-aware, and
 * reports whether the nesting stays within `max_depth`. Pure C: compiled
 * into the host tests as well as the firmware. */
#include <stdbool.h>
#include <stddef.h>

/* The depth any FrameOS payload legitimately reaches is well under this;
 * scenes.json nests apps → config → arrays about ten deep. */
#define FOS_JSON_MAX_DEPTH 32

/* True when `len` bytes of `text` never nest deeper than `max_depth`
 * (quotes and escapes honoured, so brackets inside strings do not count).
 * A NULL text is "ok": there is nothing to overflow on. */
bool fos_json_depth_ok(const char *text, size_t len, int max_depth);

/* True when `len` bytes of `text`, white space aside, open with `[` and close
 * with `]`, or open with `{` and close with `}`: a payload cut short (its
 * last byte lost on a serial line) or with a stray byte in front fails it,
 * at the cost of two scans for space, not a parse. */
bool fos_json_whole(const char *text, size_t len);
