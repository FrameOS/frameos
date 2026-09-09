/*
 * minisign signature-file parser, kept IDF-free so the parser that gates
 * every OTA image can be tested on a laptop (main/tests/test_fos_minisig.c).
 *
 * A .minisig is text: an `untrusted comment:` line, the base64 signature
 * line, and optionally a `trusted comment:` line plus a global signature.
 * The device trusts only the key, so everything but the first signature
 * line is ignored. The signature line decodes to 74 bytes:
 * "ED" (the prehashed Ed25519 algorithm id) + 8-byte key id + 64-byte sig.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Strict standard base64 (RFC 4648 alphabet, padding optional, no
 * whitespace inside). Returns false on any other character, a length of
 * 4k+1, or output that would not fit `out_cap`. */
bool fos_minisig_base64_decode(const char *in, size_t in_len, uint8_t *out,
                               size_t out_cap, size_t *out_len);

/* Parse the first signature line of a .minisig into `sig_out`, refusing
 * anything but the "ED" algorithm signed by `key_id`. `why` (optional)
 * receives a static token on failure: "empty", "bad-base64",
 * "unsupported-format", "key-id-mismatch". */
bool fos_minisig_parse(const char *minisig, const uint8_t key_id[8],
                       uint8_t sig_out[64], const char **why);
