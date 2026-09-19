// A reader for the handful of JSON documents the Pico receives (the settings
// pull) and an escaper for the ones it writes (status, logs). Not a parser:
// it never builds a tree, it walks the text and hands back slices of it, so a
// 10 KB settings document costs no heap beyond the buffer it arrived in.
// Portable, host-tested (tests/test_pk_json.c).
#ifndef PK_JSON_H
#define PK_JSON_H

#include <stdbool.h>
#include <stddef.h>

// Nesting deeper than this is refused rather than recursed into: the walker
// runs on the main stack next to lwIP and mbedTLS.
#define PK_JSON_MAX_DEPTH 16

typedef struct {
    const char *start; // first byte of the value (the opening quote of a string)
    size_t len;        // bytes in the value, quotes included
} pk_json_slice_t;

// The value at a dotted path of object keys ("frame.adminAuth.user") inside
// the document. False when a key is missing, a step is not an object, or the
// document is malformed up to that point.
bool pk_json_find(const char *json, size_t len, const char *path, pk_json_slice_t *out);

// True when the whole text is exactly one well-formed JSON value.
bool pk_json_valid(const char *json, size_t len);

bool pk_json_is_null(pk_json_slice_t value);
bool pk_json_as_bool(pk_json_slice_t value, bool *out);
// Integers only; a number with a fraction or exponent is truncated toward zero.
bool pk_json_as_long(pk_json_slice_t value, long *out);
// Unescapes into dst (NUL-terminated). False when the value is not a string
// or does not fit; \uXXXX becomes UTF-8, surrogate pairs included.
bool pk_json_as_string(pk_json_slice_t value, char *dst, size_t cap);

// Appends src to dst as the *contents* of a JSON string (no quotes). Returns
// the number of bytes written excluding the NUL; output that does not fit is
// cut at a character boundary, never mid-escape.
size_t pk_json_escape(const char *src, char *dst, size_t cap);
// The length pk_json_escape() needs for the whole of src (excluding the NUL).
size_t pk_json_escaped_len(const char *src);

#endif // PK_JSON_H
