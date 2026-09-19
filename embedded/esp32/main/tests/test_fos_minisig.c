/*
 * Host tests for the minisign signature-file parser (fos_minisig.c) that
 * gates every OTA image, cloud and backend alike. No IDF, no mocks.
 *
 * Build and run (from embedded/esp32/):
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Imain -Icomponents/monocypher \
 *      main/fos_minisig.c main/tests/test_fos_minisig.c \
 *      components/monocypher/monocypher.c components/monocypher/monocypher-ed25519.c \
 *      -o /tmp/test_fos_minisig && /tmp/test_fos_minisig
 *
 * (.github/workflows/e2e-docker.yml runs exactly that in CI.)
 *
 * The parser extracts the signature bytes, the key id, the trusted comment
 * and the global signature. The Ed25519 verification of the image digest
 * happens in fos_ota.c; the one that decides what the image was signed AS
 * (sig || comment) is fos_minisig_verify_binding, run here with the real
 * monocypher against a real release signature and the production key. What can go wrong here is accepting a blob that is not
 * a signature by our key (wrong algorithm, wrong key id, truncated,
 * trailing bytes) and handing the verifier 64 bytes of something else.
 */
#include <stdio.h>
#include <string.h>

#include "fos_minisig.h"
#include "fos_ota_pubkey.h"

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

/* A .minisig the release workflow really published (v2026.9.19, the arm64
 * runtime archive): the shape every release signature has, byte for byte. */
static const char REAL_MINISIG[] =
    "untrusted comment: signature from FrameOS firmware key\n"
    "RUQnxMf13zADcFFcQyFKSGSP8dlnMFEnZtwiPYna8r7uZj3THgXiAyf55UahO6vTTswZUqCwN9/E/UsA5X9OcUiuBsjcK/nDeww=\n"
    "trusted comment: frameos frameos-2026.9.19-debian-bookworm-arm64.tar.gz\n"
    "uzpKdt8H7PSIz+P45GNmLUyI6GI3VVaytR4nGc7yjYeQMSns8swLi35Bf6rObL2ckov4/B+11BuzuTcHU+TsDg==\n";

static void test_binding_parse(void)
{
    char comment[FOS_MINISIG_COMMENT_MAX];
    uint8_t global_sig[64];
    const char *why = "unset";
    CHECK(fos_minisig_parse_binding(REAL_MINISIG, comment, global_sig, &why),
          "real minisig refused: %s", why ? why : "(null)");
    CHECK(why == NULL, "why not cleared on success");
    CHECK(strcmp(comment, "frameos frameos-2026.9.19-debian-bookworm-arm64.tar.gz") == 0,
          "comment = \"%s\"", comment);
    CHECK(global_sig[0] == 0xbb && global_sig[1] == 0x3a && global_sig[63] == 0x0e,
          "global signature bytes differ");
    /* …and the file signature still parses out of the same text. */
    uint8_t sig[64];
    CHECK(fos_minisig_parse(REAL_MINISIG, KEY_ID, sig, &why), "file signature refused");

    /* CRLF: the \r is a line ending, not part of what was signed. */
    char file[512];
    snprintf(file, sizeof(file),
             "untrusted comment: x\r\nAAAA\r\ntrusted comment: frameos a.bin\r\n%s\r\n",
             "uzpKdt8H7PSIz+P45GNmLUyI6GI3VVaytR4nGc7yjYeQMSns8swLi35Bf6rObL2ckov4/B+11BuzuTcHU+TsDg==");
    CHECK(fos_minisig_parse_binding(file, comment, global_sig, &why) &&
          strcmp(comment, "frameos a.bin") == 0, "CRLF binding: %s", why ? why : comment);
    /* Inner and trailing spaces ARE signed bytes and are kept. */
    snprintf(file, sizeof(file), "AAAA\ntrusted comment: frameos  a.bin \n%s",
             "uzpKdt8H7PSIz+P45GNmLUyI6GI3VVaytR4nGc7yjYeQMSns8swLi35Bf6rObL2ckov4/B+11BuzuTcHU+TsDg==");
    CHECK(fos_minisig_parse_binding(file, comment, global_sig, &why) &&
          strcmp(comment, "frameos  a.bin ") == 0, "spaces kept: \"%s\"", comment);
}

static void test_binding_refusals(void)
{
    char comment[FOS_MINISIG_COMMENT_MAX];
    uint8_t global_sig[64];
    const char *why = NULL;
    char file[1024];

    /* A bare file signature — what this firmware accepted before. */
    CHECK(!fos_minisig_parse_binding("untrusted comment: x\nAAAA\n", comment, global_sig, &why) &&
          why && strcmp(why, "no-trusted-comment") == 0, "bare signature: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse_binding("", comment, global_sig, &why), "empty accepted");
    CHECK(!fos_minisig_parse_binding("AAAA\ntrusted comment: \nAAAA\n", comment, global_sig, &why),
          "empty comment accepted");
    /* "untrusted comment: trusted comment: …" is not a trusted comment. */
    CHECK(!fos_minisig_parse_binding("untrusted comment: trusted comment: frameos a.bin\nAAAA\n",
                                     comment, global_sig, &why), "untrusted line taken as trusted");

    /* Comment with no, short, or junk global signature. */
    CHECK(!fos_minisig_parse_binding("AAAA\ntrusted comment: frameos a.bin\n", comment, global_sig, &why) &&
          why && strcmp(why, "bad-global-signature") == 0, "missing global: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse_binding("AAAA\ntrusted comment: frameos a.bin", comment, global_sig, &why),
          "unterminated comment accepted");
    CHECK(!fos_minisig_parse_binding("AAAA\ntrusted comment: frameos a.bin\nZm9v\n", comment, global_sig, &why) &&
          why && strcmp(why, "bad-global-signature") == 0, "3-byte global: %s", why ? why : "(null)");
    CHECK(!fos_minisig_parse_binding("AAAA\ntrusted comment: frameos a.bin\nnot base64!!\n", comment,
                                     global_sig, &why), "junk global accepted");
    uint8_t blob[80];
    char b64[128];
    memset(blob, 0x5a, sizeof(blob));
    b64_encode(blob, 65, b64, sizeof(b64));
    snprintf(file, sizeof(file), "AAAA\ntrusted comment: frameos a.bin\n%s\n", b64);
    CHECK(!fos_minisig_parse_binding(file, comment, global_sig, &why), "65-byte global accepted");

    /* Two trusted comments: refusing beats guessing which one was signed. */
    b64_encode(blob, 64, b64, sizeof(b64));
    snprintf(file, sizeof(file),
             "AAAA\ntrusted comment: frameos a.bin\ntrusted comment: frameos b.bin\n%s\n", b64);
    CHECK(!fos_minisig_parse_binding(file, comment, global_sig, &why), "two comments accepted");

    /* Bounded: a comment that would not fit is refused, never truncated —
     * a truncated comment could compare equal to a shorter, different name. */
    char longc[FOS_MINISIG_COMMENT_MAX + 8];
    memset(longc, 'a', sizeof(longc) - 1);
    longc[sizeof(longc) - 1] = '\0';
    snprintf(file, sizeof(file), "AAAA\ntrusted comment: %s\n%s\n", longc, b64);
    CHECK(!fos_minisig_parse_binding(file, comment, global_sig, &why) && why &&
          strcmp(why, "comment-too-long") == 0, "long comment: %s", why ? why : "(null)");
    longc[FOS_MINISIG_COMMENT_MAX - 1] = '\0'; /* exactly MAX-1 chars: fits with the NUL */
    snprintf(file, sizeof(file), "AAAA\ntrusted comment: %s\n%s\n", longc, b64);
    CHECK(fos_minisig_parse_binding(file, comment, global_sig, &why) &&
          strlen(comment) == FOS_MINISIG_COMMENT_MAX - 1, "MAX-1 comment refused");
}

static void test_comment_names_ota_image(void)
{
    const char *c = "frameos frameos-2026.9.19-esp32-s3-generic-app.bin";
    CHECK(fos_minisig_comment_names_ota_image(c, "2026.9.19", "esp32-s3-generic"), "exact name refused");
    /* An old image served as a new version; another layout; another chip. */
    CHECK(!fos_minisig_comment_names_ota_image(c, "2026.9.20", "esp32-s3-generic"), "other version accepted");
    CHECK(!fos_minisig_comment_names_ota_image(c, "2026.9.19", "esp32-s3-16mb"), "other layout accepted");
    CHECK(!fos_minisig_comment_names_ota_image(c, "2026.9.19", "esp32-c3-generic"), "other chip accepted");
    /* The MERGED flash image of the same release is not an OTA payload. */
    CHECK(!fos_minisig_comment_names_ota_image("frameos frameos-2026.9.19-esp32-s3-generic.bin",
                                               "2026.9.19", "esp32-s3-generic"), "merged image accepted");
    /* Prefix/suffix games and degenerate inputs. */
    CHECK(!fos_minisig_comment_names_ota_image("frameos frameos-2026.9.19-esp32-s3-generic-app.bin.old",
                                               "2026.9.19", "esp32-s3-generic"), "suffix accepted");
    CHECK(!fos_minisig_comment_names_ota_image("frameos-2026.9.19-esp32-s3-generic-app.bin",
                                               "2026.9.19", "esp32-s3-generic"), "missing prefix accepted");
    CHECK(!fos_minisig_comment_names_ota_image(c, "", "esp32-s3-generic"), "empty version accepted");
    CHECK(!fos_minisig_comment_names_ota_image(c, "2026.9.19", ""), "empty platform accepted");
    CHECK(!fos_minisig_comment_names_ota_image(NULL, "2026.9.19", "esp32-s3-generic"), "NULL comment accepted");
}

/* The same real signature for an OTA image, so the whole decision runs:
 * production key, real global signature, this device's version + platform. */
static const char REAL_OTA_MINISIG[] =
    "untrusted comment: signature from FrameOS firmware key\n"
    "RUQnxMf13zADcMJGZubfpnSgGluS5Rd85CuSVNbAiesHySbsmeomO/DrOzfTH0s97pw4neX7P9DLab/Oyg0Em67kd5EI/PL+ogk=\n"
    "trusted comment: frameos frameos-2026.9.19-esp32-s3-generic-app.bin\n"
    "4FU6TkoH4T8njXAxxN1NVwgoRSwgboZitAfE7M1uu3cttRo5inCsibMQ2e3dZZmNKx+ubhuH+16o+95MMzaoCA==\n";

static void test_verify_binding_real_signature(void)
{
    uint8_t sig[64];
    char signed_as[FOS_MINISIG_COMMENT_MAX];
    const char *why = "unset";
    CHECK(fos_minisig_parse(REAL_OTA_MINISIG, FOS_OTA_SIGNING_KEY_ID, sig, &why),
          "production key id refused: %s", why ? why : "(null)");

    CHECK(fos_minisig_verify_binding(REAL_OTA_MINISIG, sig, FOS_OTA_SIGNING_PUBKEY, "2026.9.19",
                                     "esp32-s3-generic", signed_as, &why),
          "real signature refused: %s", why ? why : "(null)");
    CHECK(why == NULL, "why not cleared on success");
    CHECK(fos_minisig_verify_binding(REAL_OTA_MINISIG, sig, FOS_OTA_SIGNING_PUBKEY, "2026.9.19",
                                     "esp32-s3-generic", NULL, NULL), "NULL outputs refused");

    /* THE attack (docs/security-todo.md): the genuinely signed 2026.9.19
     * image re-served as a newer release, or to another flash layout. */
    CHECK(!fos_minisig_verify_binding(REAL_OTA_MINISIG, sig, FOS_OTA_SIGNING_PUBKEY, "2026.10.1",
                                      "esp32-s3-generic", signed_as, &why) &&
          why && strcmp(why, "signed-for-another-release") == 0, "replay as newer: %s", why ? why : "(null)");
    CHECK(strcmp(signed_as, "frameos frameos-2026.9.19-esp32-s3-generic-app.bin") == 0,
          "signed_as = \"%s\"", signed_as);
    CHECK(!fos_minisig_verify_binding(REAL_OTA_MINISIG, sig, FOS_OTA_SIGNING_PUBKEY, "2026.9.19",
                                      "esp32-s3-16mb", signed_as, &why), "other layout accepted");

    /* Rewriting the comment to match breaks the global signature. */
    char forged[sizeof(REAL_OTA_MINISIG) + 1];
    strcpy(forged, REAL_OTA_MINISIG);
    char *at = strstr(forged, "2026.9.19");
    CHECK(at != NULL, "fixture has no version");
    if (at != NULL) memcpy(at, "2026.9.20", 9);
    CHECK(!fos_minisig_verify_binding(forged, sig, FOS_OTA_SIGNING_PUBKEY, "2026.9.20",
                                      "esp32-s3-generic", signed_as, &why) &&
          why && strcmp(why, "comment-not-signed") == 0, "forged comment: %s", why ? why : "(null)");
    CHECK(signed_as[0] == '\0', "an unverified comment was handed back: \"%s\"", signed_as);

    /* The global signature covers the FILE signature too: this comment under
     * another image's signature is not a statement about that image. */
    uint8_t other_sig[64];
    memcpy(other_sig, sig, 64);
    other_sig[5] ^= 0x01;
    CHECK(!fos_minisig_verify_binding(REAL_OTA_MINISIG, other_sig, FOS_OTA_SIGNING_PUBKEY,
                                      "2026.9.19", "esp32-s3-generic", signed_as, &why) &&
          why && strcmp(why, "comment-not-signed") == 0, "comment moved to another signature");

    /* And a key that is not the release key signs nothing. */
    uint8_t other_key[32];
    memcpy(other_key, FOS_OTA_SIGNING_PUBKEY, 32);
    other_key[0] ^= 0x01;
    CHECK(!fos_minisig_verify_binding(REAL_OTA_MINISIG, sig, other_key, "2026.9.19",
                                      "esp32-s3-generic", signed_as, &why), "other key accepted");
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
    test_binding_parse();
    test_binding_refusals();
    test_comment_names_ota_image();
    test_verify_binding_real_signature();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
