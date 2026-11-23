/* QR codes, byte mode, level L. See fos_qr.h; the steps and their order are
 * frameos/src/frameos/utils/qr.nim's, so a fix there is a fix here. */
#include "fos_qr.h"

#include <string.h>

/* Level L, by version - 1. */
static const uint8_t ECC_PER_BLOCK[FOS_QR_MAX_VERSION] = {7, 10, 15, 20, 26, 18, 20, 24, 30, 18};
static const uint8_t BLOCKS[FOS_QR_MAX_VERSION] = {1, 1, 1, 1, 1, 2, 2, 2, 2, 4};

static int raw_codewords(int version)
{
    int result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        int n = version / 7 + 2;
        result -= (25 * n - 10) * n - 55;
        if (version >= 7) result -= 36;
    }
    return result / 8;
}

static int data_codewords(int version)
{
    return raw_codewords(version) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];
}

static int gf_mul(int x, int y)
{
    int result = 0;
    for (int i = 7; i >= 0; i--) {
        result = (result << 1) ^ ((result >> 7) * 0x11D);
        result ^= ((y >> i) & 1) * x;
    }
    return result;
}

static void put_bits(uint8_t *data, int *bit_len, int value, int count)
{
    for (int i = count - 1; i >= 0; i--) {
        if ((value >> i) & 1) data[*bit_len >> 3] |= (uint8_t)(0x80u >> (*bit_len & 7));
        (*bit_len)++;
    }
}

static void put(fos_qr_t *qr, int x, int y, bool dark)
{
    qr->cells[y * qr->size + x] = (uint8_t)(2u | (dark ? 1u : 0u));
}

/* The format bits (both copies) and, from version 7, the version bits:
 * drawn light first to reserve their modules, for real once the mask is
 * chosen. */
static void draw_info(fos_qr_t *qr, int format, int version)
{
    const int n = qr->size;
    for (int i = 0; i <= 14; i++) {
        bool bit = ((format >> i) & 1) != 0;
        if (i < 8) put(qr, 8, i + (i >= 6), bit);
        else put(qr, 14 - i + (i == 8), 8, bit);
        if (i < 8) put(qr, n - 1 - i, 8, bit);
        else put(qr, 8, n - 15 + i, bit);
    }
    if (n >= 45) {
        for (int i = 0; i < 18; i++) {
            bool bit = ((version >> i) & 1) != 0;
            put(qr, n - 11 + i % 3, i / 3, bit);
            put(qr, i / 3, n - 11 + i % 3, bit);
        }
    }
}

static void apply_mask(fos_qr_t *qr, int mask)
{
    const int n = qr->size;
    for (int y = 0; y < n; y++) {
        for (int x = 0; x < n; x++) {
            bool flip;
            switch (mask) {
                case 0: flip = (x + y) % 2 == 0; break;
                case 1: flip = y % 2 == 0; break;
                case 2: flip = x % 3 == 0; break;
                case 3: flip = (x + y) % 3 == 0; break;
                case 4: flip = (x / 3 + y / 2) % 2 == 0; break;
                case 5: flip = x * y % 2 + x * y % 3 == 0; break;
                case 6: flip = (x * y % 2 + x * y % 3) % 2 == 0; break;
                default: flip = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
            }
            uint8_t *cell = &qr->cells[y * n + x];
            if (flip && *cell < 2) *cell = (uint8_t)(1u - *cell);
        }
    }
}

static int penalty(const fos_qr_t *qr)
{
    const int n = qr->size;
    int result = 0;
    for (int vertical = 0; vertical < 2; vertical++) {
        for (int i = 0; i < n; i++) {
            int run = 0;
            int window = 0;
            bool previous = false;
            for (int j = 0; j < n; j++) {
                bool dark = (qr->cells[vertical ? j * n + i : i * n + j] & 1u) != 0;
                if (j > 0 && dark == previous) {
                    run++;
                } else {
                    if (run >= 5) result += run - 2;
                    run = 1;
                }
                previous = dark;
                window = ((window << 1) | dark) & 0x7FF;
                if (j >= 10 && (window == 0x5D0 || window == 0x05D)) result += 40;
            }
            if (run >= 5) result += run - 2;
        }
    }
    int dark_count = 0;
    for (int i = 0; i < n * n; i++) {
        uint8_t dark = qr->cells[i] & 1u;
        dark_count += dark;
        if (i % n < n - 1 && i < n * (n - 1) && (qr->cells[i + 1] & 1u) == dark &&
            (qr->cells[i + n] & 1u) == dark && (qr->cells[i + n + 1] & 1u) == dark) {
            result += 3;
        }
    }
    int balance = dark_count * 100 / (n * n) * 2 - 99;
    if (balance < 0) balance = -balance;
    return result + balance / 10 * 10;
}

bool fos_qr_encode(const char *text, fos_qr_t *qr)
{
    if (text == NULL || qr == NULL) return false;
    const size_t text_len = strlen(text);
    if (text_len > FOS_QR_MAX_RAW) return false;
    const int len = (int)text_len;
    int version = 1;
    int count_bits;
    for (;;) {
        count_bits = version <= 9 ? 8 : 16;
        if (4 + count_bits + len * 8 <= data_codewords(version) * 8) break;
        if (version == FOS_QR_MAX_VERSION) return false;
        version++;
    }

    const int capacity = data_codewords(version);
    uint8_t *data = qr->data;
    memset(data, 0, sizeof(qr->data));
    int bit_len = 0;
    put_bits(data, &bit_len, 4, 4);
    put_bits(data, &bit_len, len, count_bits);
    for (int i = 0; i < len; i++) put_bits(data, &bit_len, (uint8_t)text[i], 8);
    /* The terminator and the bits up to a byte are zeros, which `data` holds. */
    int pad = 0xEC;
    int end = bit_len + 4 < capacity * 8 ? bit_len + 4 : capacity * 8;
    for (int k = (end + 7) / 8; k < capacity; k++) {
        data[k] = (uint8_t)pad;
        pad ^= 0xFD;
    }

    /* Error correction per block, data and ECC interleaved block by block. */
    const int blocks = BLOCKS[version - 1];
    const int ecc = ECC_PER_BLOCK[version - 1];
    const int raw = raw_codewords(version);
    const int short_blocks = blocks - raw % blocks;
    const int short_data = raw / blocks - ecc;
    int divisor[30] = {0};
    divisor[ecc - 1] = 1;
    int root = 1;
    for (int i = 0; i < ecc; i++) {
        for (int j = 0; j < ecc; j++) {
            divisor[j] = gf_mul(divisor[j], root);
            if (j + 1 < ecc) divisor[j] ^= divisor[j + 1];
        }
        root = gf_mul(root, 2);
    }
    uint8_t *codewords = qr->codewords;
    int offset = 0;
    for (int b = 0; b < blocks; b++) {
        int remainder[30] = {0};
        const int count = short_data + (b >= short_blocks);
        for (int k = 0; k < count; k++) {
            int value = data[offset + k];
            codewords[k < short_data ? k * blocks + b : short_data * blocks + b - short_blocks] = (uint8_t)value;
            int factor = value ^ remainder[0];
            for (int j = 0; j < ecc; j++) {
                remainder[j] = (j + 1 < ecc ? remainder[j + 1] : 0) ^ gf_mul(divisor[j], factor);
            }
        }
        for (int j = 0; j < ecc; j++) codewords[capacity + j * blocks + b] = (uint8_t)remainder[j];
        offset += count;
    }

    /* Function patterns: timing, finders with their separators, alignment. */
    const int n = version * 4 + 17;
    qr->size = n;
    memset(qr->cells, 0, (size_t)n * (size_t)n);
    for (int k = 0; k < n; k++) {
        put(qr, 6, k, k % 2 == 0);
        put(qr, k, 6, k % 2 == 0);
    }
    const int finders[3][2] = {{3, 3}, {n - 4, 3}, {3, n - 4}};
    for (int f = 0; f < 3; f++) {
        for (int dy = -4; dy <= 4; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                int x = finders[f][0] + dx;
                int y = finders[f][1] + dy;
                if (x < 0 || x >= n || y < 0 || y >= n) continue;
                int ax = dx < 0 ? -dx : dx;
                int ay = dy < 0 ? -dy : dy;
                int ring = ax > ay ? ax : ay;
                put(qr, x, y, ring != 2 && ring != 4);
            }
        }
    }
    if (version > 1) {
        const int count = version / 7 + 2;
        const int step = (version * 4 + count * 2 + 1) / (count * 2 - 2) * 2;
        int positions[3];
        positions[0] = 6;
        for (int k = 1; k < count; k++) positions[k] = n - 7 - (count - 1 - k) * step;
        for (int a = 0; a < count; a++) {
            for (int b = 0; b < count; b++) {
                if ((a == 0 && b == 0) || (a == 0 && b == count - 1) || (a == count - 1 && b == 0)) continue;
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        int ax = dx < 0 ? -dx : dx;
                        int ay = dy < 0 ? -dy : dy;
                        put(qr, positions[a] + dx, positions[b] + dy, (ax > ay ? ax : ay) != 1);
                    }
                }
            }
        }
    }
    draw_info(qr, 0, 0);
    put(qr, 8, n - 8, true);

    /* Data in two-module columns, zigzagging up and down from the right. */
    int bit = 0;
    for (int right = n - 1; right >= 1; right -= 2) {
        if (right == 6) right = 5;
        for (int vert = 0; vert < n; vert++) {
            for (int j = 0; j < 2; j++) {
                int x = right - j;
                int y = ((right + 1) & 2) == 0 ? n - 1 - vert : vert;
                uint8_t *cell = &qr->cells[y * n + x];
                if (*cell < 2 && bit < raw * 8) {
                    *cell = (uint8_t)((codewords[bit >> 3] >> (7 - (bit & 7))) & 1);
                    bit++;
                }
            }
        }
    }

    int best = 0;
    int best_penalty = 0x7FFFFFFF;
    for (int mask = 0; mask < 8; mask++) {
        apply_mask(qr, mask);
        int score = penalty(qr);
        if (score < best_penalty) {
            best = mask;
            best_penalty = score;
        }
        apply_mask(qr, mask);
    }
    apply_mask(qr, best);
    int format = 8 | best; /* level L is 01 */
    for (int i = 0; i < 10; i++) format = (format << 1) ^ ((format >> 9) * 0x537);
    format = (((8 | best) << 10) | format) ^ 0x5412;
    int version_bits = version;
    for (int i = 0; i < 12; i++) version_bits = (version_bits << 1) ^ ((version_bits >> 11) * 0x1F25);
    draw_info(qr, format, (version << 12) | version_bits);
    return true;
}
