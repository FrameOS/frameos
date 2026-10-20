#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The bookkeeping of one OTA image download (fos_ota.c), kept free of the
 * IDF so a laptop compiler can test it (main/tests/test_fos_ota_download.c).
 *
 * A download is a run of connections. The first asks for the whole image;
 * one that drops mid-image is followed by another that asks for the rest
 * (`Range: bytes=<written>-`), and the hash and the OTA slot carry on where
 * they were. A server that ignores the range and sends the whole image again
 * is read past the bytes already written instead. Every connection that ends
 * short leaves a try ("closed@12420"), and the verdict lists them: before
 * this only the last attempt's reason survived the restart, and that reason
 * was always "UNKNOWN ERROR" (CONFIG_ESP_ERR_TO_NAME_LOOKUP is off).
 */

/* esp_http_client_read's "nothing arrived within timeout_ms" is
 * -ESP_ERR_HTTP_EAGAIN. Repeated here so this file needs no IDF header;
 * fos_ota.c checks the two agree at compile time. */
#define FOS_OTA_DL_HTTP_EAGAIN 0x7007

/* Connections in a row that add no byte before the run gives up. */
#define FOS_OTA_DL_STALLED_TRIES 3
/* Connections per run, progress or not. A link that drops every few hundred
 * KB still finishes a 3 MB image well inside this; one that drops every few
 * KB stops before it burns the cloud's per-frame download budget (10 an
 * hour, app/api/frames/[frameId]/firmware/download/route.ts). */
#define FOS_OTA_DL_MAX_CONNECTIONS 8

typedef struct {
    size_t expected;      /* the manifest's size (always given, fos_ota.c refuses a manifest without) */
    size_t written;       /* bytes hashed and written to the slot */
    size_t skip;          /* bytes still to drop from this response (a resume answered with 200) */
    size_t conn_start;    /* `written` when the current connection opened */
    unsigned connections; /* opened this run */
    unsigned stalled;     /* consecutive failed tries that added nothing */
    unsigned tries;       /* failed tries this run */
    char last[32];        /* the latest, "closed@12420" */
    char trail[96];       /* every try that fits, oldest first; sized so the verdict stays under 160 */
} fos_ota_dl_t;

void fos_ota_dl_init(fos_ota_dl_t *dl, size_t expected);

/* A connection is about to open. True, with `range` filled ("bytes=N-"),
 * when it resumes; false on the first connection of the run. */
bool fos_ota_dl_begin_connection(fos_ota_dl_t *dl, char *range, size_t range_len);

/* The response's status and Content-Length (<= 0: unknown). True when the
 * body is the image (200) or the rest of it (206 to a resume); otherwise
 * `why` holds the try's name ("http 404", "length 5"). */
bool fos_ota_dl_accept(fos_ota_dl_t *dl, int status, int64_t content_length,
                       char *why, size_t why_len);

/* `n` body bytes arrived: how many of them, from the front, to drop. */
size_t fos_ota_dl_drop(fos_ota_dl_t *dl, size_t n);

/* A connection ended without the image (or the Wi-Fi did not come back for
 * one): records `name` at the current byte count. True when another
 * connection is worth making. */
bool fos_ota_dl_failed(fos_ota_dl_t *dl, const char *name);

/* Names a failed esp_http_client_read: "timeout" (no byte for timeout_ms),
 * "closed" (the peer ended the connection), "read e<errno>" (a socket error). */
void fos_ota_dl_read_name(int result, int sock_errno, char *out, size_t len);

/* The run's verdict for the `ota:<plane>` error line:
 * "download-failed:closed@12420/3106000", and with more than one try
 * " (3 tries: timeout@0, closed@12420, closed@12420)". */
void fos_ota_dl_summary(const fos_ota_dl_t *dl, char *out, size_t len);
