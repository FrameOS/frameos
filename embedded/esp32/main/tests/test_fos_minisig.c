/*
 * Host tests for the minisign signature-file parser (fos_minisig.c) that
 * gates every OTA image, cloud and backend alike. No IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain \
 *      main/fos_minisig.c main/tests/test_fos_minisig.c \
 *      -o /tmp/test_fos_minisig && /tmp/test_fos_minisig
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The parser only extracts the 64 signature bytes and checks the key id;
 * the Ed25519 verification over the BLAKE2b digest happens in fos_ota.c
 * with monocypher. What can go wrong here is accepting a blob that is not
 * a signature by our key (wrong algorithm, wrong key id, truncated,
 * trailing bytes) and handing the verifier 64 bytes of something else.
 */
#include <stdio.h>
#include <string.h>

#include "fos_minisig.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...)                                                       \
    do {                                                                       \
        g_checks++;                                                            \
        if (!(cond)) {                                                         \
            g_failures++;                                                      \
            printf("FAIL %s:%d: ", __func__, __LINE__);                        \
            printf(__VA_ARGS__);                                               \
            printf("\n");                                                      \
        }                                                                      \
    } while (0)

static const uint8_t KEY_ID[8] = { 0x27, 0xc4, 0xc7, 0xf5, 0xdf, 0x30, 0x03, 0x70 };
static const uint8_t OTHER_KEY_ID[8] = { 0x27, 0xc4, 0xc7, 0xf5, 0xdf, 0x30, 0x03, 0x71 };

/* Test-side encoder (the module only decodes). Standard alphabet, padded. */
static void b64_encode(const uint8_t *in, size_t in_len, char *out, size_t out_cap)
{
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < in_len; i += 3) {
        unsigned v = (unsigned)in[i] << 16;
        if (i + 1 < in_len) v |= (unsigned)in[i + 1] << 8;
        if (i + 2 < in_len) v |= in[i + 2];
        if (o + 5 > out_cap) break;
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
        out[o++] = i + 1 < in_len ? alphabet[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < in_len ? alphabet[v & 63] : '=';
    }
    out[o] = '\0';
}

/* A 74-byte minisign signature blob: algorithm + key id + 64 sig bytes. */
static size_t make_blob(uint8_t *blob, const char *alg, const uint8_t key_id[8], uint8_t seed)
{
    blob[0] = (uint8_t)alg[0];
    blob[1] = (uint8_t)alg[1];
    memcpy(blob + 2, key_id, 8);
    for (int i = 0; i < 64; i++) blob[10 + i] = (uint8_t)(seed + i * 7);
    return 74;
}

static void expect_decode(const char *in, const char *want, size_t want_len)
{
    uint8_t out[64];
    size_t out_len = 0;
    bool ok = fos_minisig_base64_decode(in, strlen(in), out, sizeof(out), &out_len);
    g_checks++;
    if (want == NULL) {
        if (ok) {
            g_failures++;
            printf("FAIL b64 %-12s decoded %u bytes, want refused\n", in, (unsigned)out_len);
        }
    } else if (!ok || out_len != want_len || memcmp(out, want, want_len) != 0) {
        g_failures++;
        printf("FAIL b64 %-12s -> %s (%u bytes), want %u bytes\n", in, ok ? "ok" : "refused",
               (unsigned)out_len, (unsigned)want_len);
    }
}

/* --------------------------------------------------------------------- */

static void test_base64_vectors(void)
{
    expect_decode("", "", 0);
    expect_decode("Zg==", "f", 1);
    expect_decode("Zm8=", "fo", 2);
    expect_decode("Zm9v", "foo", 3);
    expect_decode("Zm9vYg==", "foob", 4);
    expect_decode("Zm9vYmE=", "fooba", 5);
    expect_decode("Zm9vYmFy", "foobar", 6);
    /* Unpadded input is accepted (mbedtls, which this replaced, took it too). */
    expect_decode("Zg", "f", 1);
    expect_decode("Zm8", "fo", 2);
    expect_decode("+/+/", "\xfb\xff\xbf", 3);

    expect_decode("Z", NULL, 0);           /* a lone sextet */
    expect_decode("Zm9vY", NULL, 0);
    expect_decode("Zg=", NULL, 0);         /* padding that does not complete a quantum */
    expect_decode("Zg===", NULL, 0);
    expect_decode("Zm9v=", NULL, 0);
    expect_decode("Z=g=", NULL, 0);        /* data after padding */
    expect_decode("Zm9v\n", NULL, 0);      /* whitespace is the caller's to trim */
    expect_decode(" Zm9v", NULL, 0);
    expect_decode("Zm9v Zm9v", NULL, 0);
    expect_decode("Zm9-", NULL, 0);        /* url-safe alphabet is not this alphabet */
    expect_decode("Zm9_", NULL, 0);
    expect_decode("Zm9v\x80", NULL, 0);
    expect_decode("Zm9v\x01", NULL, 0);
}

static void test_base64_output_is_bounded(void)
{
    uint8_t out[2];
    size_t out_len = 99;
    CHECK(!fos_minisig_base64_decode("Zm9v", 4, out, sizeof(out), &out_len), "3 bytes into 2 accepted");
    CHECK(fos_minisig_base64_decode("Zm8=", 4, out, sizeof(out), &out_len) && out_len == 2,
          "2 bytes into 2 refused");
    CHECK(fos_minisig_base64_decode("", 0, out, 0, &out_len) && out_len == 0, "empty into 0 refused");
}

static void test_well_formed_minisig(void)
{
    uint8_t blob[80];
    size_t blob_len = make_blob(blob, "ED", KEY_ID, 0x11);
    char b64[128];
    b64_encode(blob, blob_len, b64, sizeof(b64));
    CHECK(strlen(b64) == 100, "74 bytes encode to %u chars", (unsigned)strlen(b64));

    char file[512];
    snprintf(file, sizeof(file),
             "untrusted comment: signature from minisign secret key\n%s\n"
             "trusted comment: timestamp:1757400000\tfile:frameos-esp32-s3.bin\n"
             "SGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZWFsIGdsb2JhbCBzaWc=\n", b64);

    uint8_t sig[64];
    const char *why = "unset";
    memset(sig, 0, sizeof(sig));
    CHECK(fos_minisig_parse(file, KEY_ID, sig, &why), "well-formed file refused: %s", why ? why : "(null)");
    CHECK(why == NULL, "why not cleared on success");
    CHECK(memcmp(sig, blob + 10, 64) == 0, "signature bytes differ");

    /* The signature line alone (no comments) is also fine; so is a NULL why. */
    CHECK(fos_minisig_parse(b64, KEY_ID, sig, NULL), "bare signature line refused");
    CHECK(memcmp(sig, blob + 10, 64) == 0, "signature bytes differ (bare)");
}

static void test_line_ending_and_whitespace_tolerance(void)
{
    uint8_t blob[80];
    make_blob(blob, "ED", KEY_ID, 0x22);
    char b64[128];
    b64_encode(blob, 74, b64, sizeof(b64));
    char file[512];
    uint8_t sig[64];
    const char *why = NULL;

    /* CRLF from a Windows-built release, trailing spaces, leading blank lines */
    snprintf(file, sizeof(file), "untrusted comment: x\r\n%s  \r\ntrusted comment: y\r\n", b64);
    CHECK(fos_minisig_parse(file, KEY_ID, sig, &why), "CRLF file refused: %s", why ? why : "");
    CHECK(memcmp(sig, blob + 10, 64) == 0, "CRLF signature bytes differ");

    snprintf(file, sizeof(file), "\n\n  %s", b64);
    CHECK(fos_minisig_parse(file, KEY_ID, sig, &why), "leading blank lines refused: %s", why ? why : "");

    /* Only comment lines are skipped: a comment-looking prefix elsewhere is data. */
    snprintf(file, sizeof(file), "untrusted comment: a\nuntrusted comment: b\n%s\n", b64);
    CHECK(fos_minisig_parse(file, KEY_ID, sig, &why), "two comment lines refused: %s", why ? why : "");
}

static void test_wrong_key_id(void)
{
    uint8_t blob[80];
    make_blob(blob, "ED", OTHER_KEY_ID, 0x33);
    char b64[128];
    b64_encode(blob, 74, b64, sizeof(b64));
    uint8_t sig[64];
    const char *why = NULL;
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "other key id accepted");
    CHECK(why && strcmp(why, "key-id-mismatch") == 0, "why = %s", why ? why : "(null)");
    /* …and the same blob IS valid for its own key: the check is the id, not the bytes. */
    CHECK(fos_minisig_parse(b64, OTHER_KEY_ID, sig, &why), "own key id refused");
}

static void test_unsupported_algorithm(void)
{
    uint8_t blob[80];
    char b64[128];
    uint8_t sig[64];
    const char *why = NULL;

    make_blob(blob, "Ed", KEY_ID, 0x44); /* legacy (non-prehashed) minisign id */
    b64_encode(blob, 74, b64, sizeof(b64));
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "legacy \"Ed\" accepted");
    CHECK(why && strcmp(why, "unsupported-format") == 0, "why = %s", why ? why : "(null)");

    make_blob(blob, "RD", KEY_ID, 0x44);
    b64_encode(blob, 74, b64, sizeof(b64));
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "\"RD\" accepted");
}

static void test_truncated_and_trailing(void)
{
    uint8_t blob[80];
    char b64[128];
    uint8_t sig[64];
    const char *why = NULL;
    make_blob(blob, "ED", KEY_ID, 0x55);

    b64_encode(blob, 73, b64, sizeof(b64));                /* one byte short */
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "73-byte blob accepted");
    CHECK(why && strcmp(why, "unsupported-format") == 0, "why = %s", why ? why : "(null)");

    b64_encode(blob, 10, b64, sizeof(b64));                /* header only */
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "header-only blob accepted");

    blob[74] = 0xAA;
    b64_encode(blob, 75, b64, sizeof(b64));                /* one byte over */
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "75-byte blob accepted");

    memset(blob, 0xAA, sizeof(blob));
    b64_encode(blob, 80, b64, sizeof(b64));                /* fills the decode buffer */
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "80-byte blob accepted");
    b64_encode(blob, 80, b64, sizeof(b64));
    strcat(b64, "AAAA");                                   /* overflows it */
    CHECK(!fos_minisig_parse(b64, KEY_ID, sig, &why), "83-byte blob accepted");
    CHECK(why && strcmp(why, "bad-base64") == 0, "why = %s", why ? why : "(null)");
}

static void test_bad_base64_and_empty(void)
{
    uint8_t sig[64];
    const char *why = NULL;
    CHECK(!fos_minisig_parse("", KEY_ID, sig, &why) && why && strcmp(why, "empty") == 0,
          "empty file: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse("untrusted comment: only\n", KEY_ID, sig, &why) && why &&
          strcmp(why, "empty") == 0, "comment-only file: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse("untrusted comment: no newline", KEY_ID, sig, &why) && why &&
          strcmp(why, "empty") == 0, "unterminated comment: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse("\n\n  \n", KEY_ID, sig, &why), "blank file accepted");
    CHECK(!fos_minisig_parse("not base64!!", KEY_ID, sig, &why) && why &&
          strcmp(why, "bad-base64") == 0, "junk line: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse("-----BEGIN SIGNATURE-----", KEY_ID, sig, &why), "PEM header accepted");
    /* A signature line with an inner space is one bad line, not two lines. */
    uint8_t blob[80];
    char b64[128];
    make_blob(blob, "ED", KEY_ID, 0x66);
    b64_encode(blob, 74, b64, sizeof(b64));
    char file[256];
    snprintf(file, sizeof(file), "%.*s %s", 50, b64, b64 + 50);
    CHECK(!fos_minisig_parse(file, KEY_ID, sig, &why) && why && strcmp(why, "bad-base64") == 0,
          "split line accepted: %s", why ? why : "(null)");
}

int main(void)
{
    test_base64_vectors();
    test_base64_output_is_bounded();
    test_well_formed_minisig();
    test_line_ending_and_whitespace_tolerance();
    test_wrong_key_id();
    test_unsupported_algorithm();
    test_truncated_and_trailing();
    test_bad_base64_and_empty();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
