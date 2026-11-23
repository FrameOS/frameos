/*
 * The provisioning portal's screen: what a frame with no Wi-Fi shows while
 * its setup hotspot is up. Two QR codes, as the Pi's hotspot scene draws
 * them (frameos/src/system/wifiHotspot): the first joins the hotspot, the
 * second opens the setup page, each with what it says written under it for
 * whoever types instead.
 *
 * This is the C copy, in the 5x7 font, for a board whose runtime does not
 * draw it (a C3, a panel too large for the runtime, a failed render): where it
 * renders, the runtime draws the same layout in its own font
 * (frameos/src/embedded/embedded_scene.nim renderPortalInto; fos_client.c
 * show_portal_screen picks). Keep the two alike.
 *
 * Black on white on e-paper; white on black on an LCD (`dark`), the QR codes
 * on white tiles either way, since not every phone reads a light-on-dark
 * code. A panel too small for a code a phone can read (modules under two
 * pixels) gets the same facts as lines of text.
 *
 * Plain C over a fos_panel_surface_t, no IDF: main/tests/test_fos_portal_screen.c
 * draws it at every panel size the firmware drives.
 */
#pragma once

#include <stdbool.h>

#include "fos_panel_draw.h"
#include "fos_qr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* What the screen came out as, for the log and the tests. */
typedef enum {
    FOS_PORTAL_SCREEN_TEXT = 0, /* no room for the codes */
    FOS_PORTAL_SCREEN_COLUMNS,  /* the two codes side by side */
    FOS_PORTAL_SCREEN_ROWS,     /* one above the other */
} fos_portal_screen_layout_t;

/* Paints the whole surface. `round`: only the circle inside the panel shows
 * (fos_display_round), and everything stays in it. `scratch` is two QR
 * buffers (the codes are encoded before anything is laid out, so both are
 * sized together). */
fos_portal_screen_layout_t fos_portal_screen_draw(const fos_panel_surface_t *s, const char *ssid,
                                                  const char *psk, const char *ip, bool dark, bool round,
                                                  fos_qr_t scratch[2]);

/* The Wi-Fi join code a phone's camera reads (`WIFI:T:WPA;S:…;P:…;;`, with
 * `\ ; , : "` escaped; `T:nopass` without a passphrase). False when it does
 * not fit `out`. */
bool fos_portal_wifi_code(const char *ssid, const char *psk, char *out, int out_len);

#ifdef __cplusplus
}
#endif
