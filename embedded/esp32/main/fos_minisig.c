/* See fos_minisig.h. Host-testable: main/tests/test_fos_minisig.c. */
#include "fos_minisig.h"

#include <string.h>

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
