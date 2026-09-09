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
