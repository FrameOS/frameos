/*
 * QR codes for the firmware's own screens (the provisioning portal's, in
 * fos_portal_screen.c), drawn without Nim: the C3 and every thin client have
 * no runtime to ask, and the portal screen is up before one starts.
 *
 * A port of frameos/src/frameos/utils/qr.nim cut to what a setup screen
 * needs: byte mode, level L, versions 1 to 10 (271 bytes). Same symbols
 * module for module as the Nim encoder on byte-mode text: the host test
 * (main/tests/test_fos_qr.c) replays the Nim test's byte-mode vectors, which
 * were checked with zxing-cpp when they were pinned.
 *
 * Plain C, no allocation, no IDF.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FOS_QR_MAX_VERSION 10
#define FOS_QR_MAX_SIZE (FOS_QR_MAX_VERSION * 4 + 17)
#define FOS_QR_MAX_RAW 346 /* codewords in a version 10 symbol */

typedef struct {
    int size; /* modules per side */
    uint8_t cells[FOS_QR_MAX_SIZE * FOS_QR_MAX_SIZE]; /* bit 0: dark; 2: a function module */
    uint8_t data[FOS_QR_MAX_RAW];
    uint8_t codewords[FOS_QR_MAX_RAW];
} fos_qr_t;

/* False when `text` does not fit a version 10 symbol. */
bool fos_qr_encode(const char *text, fos_qr_t *qr);

static inline bool fos_qr_dark(const fos_qr_t *qr, int x, int y)
{
    return (qr->cells[y * qr->size + x] & 1u) != 0;
}

#ifdef __cplusplus
}
#endif
