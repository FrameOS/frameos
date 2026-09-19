/*
 * minisign signature-file parser, kept IDF-free so the parser that gates
 * every OTA image can be tested on a laptop (main/tests/test_fos_minisig.c).
 *
 * A .minisig is text: an `untrusted comment:` line, the base64 signature
 * line, a `trusted comment:` line and a global signature. The signature line
 * decodes to 74 bytes: "ED" (the prehashed Ed25519 algorithm id) + 8-byte key
 * id + 64-byte sig over BLAKE2b-512 of the image. That says "FrameOS released
 * these bytes"; the trusted comment says AS WHAT — tools/sign_firmware.py
 * writes `frameos <asset name>`, e.g. `frameos frameos-2026.9.19-esp32-s3-
 * generic-app.bin` — and the global signature (Ed25519 over sig64 || comment)
 * makes the comment the signer's word. The version and the platform in a
 * manifest come from whoever answers for the control plane, so the device
 * checks all three (fos_ota.c): otherwise an old or other-layout image that
 * was genuinely signed once could be served as any version, by anyone able
 * to upload a release asset, with no signing key involved.
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

/* Longest trusted comment accepted, NUL included. The longest real one is
 * "frameos frameos-<version>-esp32-s3-generic-app.bin", well under half. */
#define FOS_MINISIG_COMMENT_MAX 128

/* The trusted comment (text after "trusted comment: ", line ending removed,
 * otherwise byte for byte — it is signed) and the 64-byte global signature
 * on the line after it. Exactly one trusted comment is accepted. `why` on
 * failure: "no-trusted-comment", "comment-too-long", "bad-global-signature".
 * This only PARSES; the caller verifies `global_sig_out` over
 * sig64 || comment with the release key before believing the comment. */
bool fos_minisig_parse_binding(const char *minisig, char comment_out[FOS_MINISIG_COMMENT_MAX],
                               uint8_t global_sig_out[64], const char **why);

/* The whole "signed as what?" decision, crypto included (monocypher): the
 * trusted comment is signed by `pubkey` — Ed25519 over `file_sig` || comment,
 * where `file_sig` is what fos_minisig_parse returned for the same text — and
 * names the OTA app image of `version` on `platform`. `why` on failure: the
 * parse tokens above, "comment-not-signed", or "signed-for-another-release"
 * (then `comment_out`, optional, holds what it WAS signed as, for the log). */
bool fos_minisig_verify_binding(const char *minisig, const uint8_t file_sig[64],
                                const uint8_t pubkey[32], const char *version,
                                const char *platform,
                                char comment_out[FOS_MINISIG_COMMENT_MAX], const char **why);

/* Whether a (verified) trusted comment is exactly the one the release
 * workflow writes for the OTA app image of `version` on `platform`:
 * "frameos frameos-<version>-<platform>-app.bin". */
bool fos_minisig_comment_names_ota_image(const char *comment, const char *version,
                                         const char *platform);
