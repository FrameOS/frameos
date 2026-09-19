/* See fos_minisig.h. Host-testable: main/tests/test_fos_minisig.c. */
#include "fos_minisig.h"

#include <stdio.h>
#include <string.h>

#include "monocypher-ed25519.h"

static int b64_value(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool fos_minisig_base64_decode(const char *in, size_t in_len, uint8_t *out,
                               size_t out_cap, size_t *out_len)
{
    size_t n = in_len;
    size_t pad = 0;
    while (n > 0 && in[n - 1] == '=') {
        n--;
        if (++pad > 2) return false;
    }
    if (n % 4 == 1) return false;              /* a lone sextet encodes nothing */
    if (pad && (n + pad) % 4 != 0) return false; /* padding must complete a quantum */

    size_t produced = 0;
    unsigned acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64_value(in[i]);
        if (v < 0) return false;
        acc = (acc << 6) | (unsigned)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (produced >= out_cap) return false;
            out[produced++] = (uint8_t)((acc >> bits) & 0xFF);
        }
    }
    *out_len = produced;
    return true;
}

bool fos_minisig_parse(const char *minisig, const uint8_t key_id[8],
                       uint8_t sig_out[64], const char **why)
{
    const char *line = minisig;
    while (line != NULL && *line != '\0') {
        while (*line == '\r' || *line == '\n' || *line == ' ') line++;
        if (strncmp(line, "untrusted comment:", 18) == 0 ||
            strncmp(line, "trusted comment:", 16) == 0) {
            line = strchr(line, '\n');
            continue;
        }
        break;
    }
    if (line == NULL || *line == '\0') {
        if (why) *why = "empty";
        return false;
    }
    const char *end = strchr(line, '\n');
    size_t b64_len = end != NULL ? (size_t)(end - line) : strlen(line);
    while (b64_len > 0 && (line[b64_len - 1] == '\r' || line[b64_len - 1] == ' ')) b64_len--;
    uint8_t blob[80];
    size_t blob_len = 0;
    if (!fos_minisig_base64_decode(line, b64_len, blob, sizeof(blob), &blob_len)) {
        if (why) *why = "bad-base64";
        return false;
    }
    if (blob_len != 74 || blob[0] != 'E' || blob[1] != 'D') {
        if (why) *why = "unsupported-format";
        return false;
    }
    if (memcmp(blob + 2, key_id, 8) != 0) {
        if (why) *why = "key-id-mismatch";
        return false;
    }
    memcpy(sig_out, blob + 10, 64);
    if (why) *why = NULL;
    return true;
}

#define TRUSTED_PREFIX "trusted comment: "
#define TRUSTED_PREFIX_LEN 17

bool fos_minisig_parse_binding(const char *minisig, char comment_out[FOS_MINISIG_COMMENT_MAX],
                               uint8_t global_sig_out[64], const char **why)
{
    const char *comment = NULL;
    size_t comment_len = 0;
    const char *after = NULL;
    const char *line = minisig;
    while (line != NULL && *line != '\0') {
        const char *end = strchr(line, '\n');
        size_t len = end != NULL ? (size_t)(end - line) : strlen(line);
        if (len >= TRUSTED_PREFIX_LEN && strncmp(line, TRUSTED_PREFIX, TRUSTED_PREFIX_LEN) == 0) {
            if (comment != NULL) { /* two comments: which one was signed? */
                if (why) *why = "no-trusted-comment";
                return false;
            }
            comment = line + TRUSTED_PREFIX_LEN;
            comment_len = len - TRUSTED_PREFIX_LEN;
            if (comment_len > 0 && comment[comment_len - 1] == '\r') comment_len--;
            after = end != NULL ? end + 1 : NULL;
        }
        line = end != NULL ? end + 1 : NULL;
    }
    if (comment == NULL || comment_len == 0) {
        if (why) *why = "no-trusted-comment";
        return false;
    }
    if (comment_len >= FOS_MINISIG_COMMENT_MAX) {
        if (why) *why = "comment-too-long";
        return false;
    }

    /* The global signature is the next non-blank line. */
    while (after != NULL && (*after == '\r' || *after == '\n' || *after == ' ')) after++;
    if (after == NULL || *after == '\0') {
        if (why) *why = "bad-global-signature";
        return false;
    }
    const char *end = strchr(after, '\n');
    size_t b64_len = end != NULL ? (size_t)(end - after) : strlen(after);
    while (b64_len > 0 && (after[b64_len - 1] == '\r' || after[b64_len - 1] == ' ')) b64_len--;
    uint8_t blob[66];
    size_t blob_len = 0;
    if (!fos_minisig_base64_decode(after, b64_len, blob, sizeof(blob), &blob_len) || blob_len != 64) {
        if (why) *why = "bad-global-signature";
        return false;
    }
    memcpy(global_sig_out, blob, 64);
    memcpy(comment_out, comment, comment_len);
    comment_out[comment_len] = '\0';
    if (why) *why = NULL;
    return true;
}

bool fos_minisig_comment_names_ota_image(const char *comment, const char *version,
                                         const char *platform)
{
    if (comment == NULL || version == NULL || platform == NULL || version[0] == '\0' ||
        platform[0] == '\0') {
        return false;
    }
    char expected[FOS_MINISIG_COMMENT_MAX];
    int n = snprintf(expected, sizeof(expected), "frameos frameos-%s-%s-app.bin", version, platform);
    if (n <= 0 || (size_t)n >= sizeof(expected)) return false;
    return strcmp(comment, expected) == 0;
}

bool fos_minisig_verify_binding(const char *minisig, const uint8_t file_sig[64],
                                const uint8_t pubkey[32], const char *version,
                                const char *platform,
                                char comment_out[FOS_MINISIG_COMMENT_MAX], const char **why)
{
    uint8_t message[64 + FOS_MINISIG_COMMENT_MAX]; /* sig64 || comment, one buffer */
    char *comment = (char *)message + 64;
    uint8_t global_sig[64];
    if (comment_out) comment_out[0] = '\0';
    if (!fos_minisig_parse_binding(minisig, comment, global_sig, why)) return false;
    memcpy(message, file_sig, 64);
    if (crypto_ed25519_check(global_sig, pubkey, message, 64 + strlen(comment)) != 0) {
        if (why) *why = "comment-not-signed";
        return false;
    }
    if (comment_out) memcpy(comment_out, comment, strlen(comment) + 1);
    if (!fos_minisig_comment_names_ota_image(comment, version, platform)) {
        if (why) *why = "signed-for-another-release";
        return false;
    }
    if (why) *why = NULL;
    return true;
}
