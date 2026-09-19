// FOSB header + packed-format arithmetic, and the change-detection hash.
#include "pk_fosb.h"
#include "pk_hash.h"
#include "pk_test.h"

static void test_sizes(void)
{
    // The user's board: 800x480 Spectra 6 at 4bpp.
    CHECK(pk_fosb_row_bytes(PK_PIXEL_4BPP_SPECTRA6, 800) == 400);
    CHECK(pk_fosb_payload_size(PK_PIXEL_4BPP_SPECTRA6, 800, 480) == 192000);
    CHECK(pk_fosb_payload_size(PK_PIXEL_4BPP_7COLOR, 600, 448) == 134400);
    CHECK(pk_fosb_payload_size(PK_PIXEL_1BPP, 800, 480) == 48000);
    CHECK(pk_fosb_row_bytes(PK_PIXEL_1BPP, 801) == 101); // odd widths round up
    CHECK(pk_fosb_row_bytes(PK_PIXEL_2BPP_GRAY, 5) == 2);
    CHECK(pk_fosb_row_bytes(PK_PIXEL_4BPP_7COLOR, 5) == 3);
    CHECK(pk_fosb_payload_size(99, 800, 480) == 0); // unknown format
    CHECK(pk_fosb_payload_size(PK_PIXEL_1BPP, 0, 480) == 0);
    CHECK(pk_fosb_payload_size(PK_PIXEL_1BPP, 800, -1) == 0);
}

static void test_header(void)
{
    // What backend/app/api/embedded_device.py fosb_payload() emits:
    // b"FOSB" + struct.pack("<BBHHH", 1, 7, 800, 480, 0)
    const uint8_t good[PK_FOSB_HEADER_LEN] = {'F', 'O', 'S', 'B', 1, 7, 0x20, 0x03, 0xE0, 0x01, 0, 0};
    pk_fosb_header_t header;
    CHECK(pk_fosb_parse_header(good, &header) == PK_FOSB_OK);
    CHECK(header.format == PK_PIXEL_4BPP_SPECTRA6);
    CHECK(header.width == 800);
    CHECK(header.height == 480);

    uint8_t bad[PK_FOSB_HEADER_LEN];
    memcpy(bad, good, sizeof(bad));
    bad[0] = 'X';
    CHECK(pk_fosb_parse_header(bad, &header) == PK_FOSB_BAD_MAGIC);
    memcpy(bad, good, sizeof(bad));
    bad[4] = 2;
    CHECK(pk_fosb_parse_header(bad, &header) == PK_FOSB_BAD_VERSION);
    memcpy(bad, good, sizeof(bad));
    bad[5] = 9; // a format this firmware has no packing for
    CHECK(pk_fosb_parse_header(bad, &header) == PK_FOSB_BAD_FORMAT);
    // An HTML error page where a payload should be.
    CHECK(pk_fosb_parse_header((const uint8_t *)"<!doctype ht", &header) == PK_FOSB_BAD_MAGIC);
}

static void test_pixels(void)
{
    uint8_t row[4];
    memset(row, pk_fosb_white_fill(PK_PIXEL_4BPP_SPECTRA6), sizeof(row));
    CHECK(row[0] == 0x11); // palette index 1 = white
    pk_fosb_row_set_black(row, PK_PIXEL_4BPP_SPECTRA6, 0);
    CHECK(row[0] == 0x01);
    pk_fosb_row_set_black(row, PK_PIXEL_4BPP_SPECTRA6, 3);
    CHECK(row[1] == 0x10);

    memset(row, pk_fosb_white_fill(PK_PIXEL_1BPP), sizeof(row));
    pk_fosb_row_set_black(row, PK_PIXEL_1BPP, 0);
    pk_fosb_row_set_black(row, PK_PIXEL_1BPP, 15);
    CHECK(row[0] == 0x7F);
    CHECK(row[1] == 0xFE);

    memset(row, pk_fosb_white_fill(PK_PIXEL_2BPP_GRAY), sizeof(row));
    pk_fosb_row_set_black(row, PK_PIXEL_2BPP_GRAY, 1);
    CHECK(row[0] == 0xCF);
}

static void test_hash(void)
{
    uint8_t a[PK_HASH_LEN], b[PK_HASH_LEN];
    const uint8_t data[] = "the same frame twice";
    pk_hash_t whole, pieces;
    pk_hash_init(&whole);
    pk_hash_update(&whole, data, sizeof(data));
    pk_hash_final(&whole, a);
    // Streaming in TCP-segment-sized pieces gives the same answer as one go.
    pk_hash_init(&pieces);
    pk_hash_update(&pieces, data, 5);
    pk_hash_update(&pieces, data + 5, 0);
    pk_hash_update(&pieces, data + 5, sizeof(data) - 5);
    pk_hash_final(&pieces, b);
    CHECK(memcmp(a, b, PK_HASH_LEN) == 0);

    // One flipped pixel changes it.
    uint8_t changed[sizeof(data)];
    memcpy(changed, data, sizeof(data));
    changed[7] ^= 0x10;
    pk_hash_init(&pieces);
    pk_hash_update(&pieces, changed, sizeof(changed));
    pk_hash_final(&pieces, b);
    CHECK(memcmp(a, b, PK_HASH_LEN) != 0);
    // The two halves are independent streams, not one value repeated.
    CHECK(memcmp(a, a + 8, 8) != 0);
}

int main(void)
{
    test_sizes();
    test_header();
    test_pixels();
    test_hash();
    return pk_test_result("test_pk_fosb");
}
