// One render pass of a thin client: pull this frame's settings, pull the
// rendered panel payload (FOSB) from the control plane, skip the refresh when
// the panel already shows exactly that, otherwise draw it; then ship the log.
//
// Two ways to get the payload to the glass, chosen at build time by whether a
// frame fits in RAM (PK_FRAMEBUFFER_BYTES):
//   - buffered (RP2350, 520 KB SRAM): the whole payload lands in a static
//     buffer first. A dropped connection never leaves the controller half
//     written, the unchanged check happens before the panel is even powered,
//     and `GET /image` can serve what is on the glass.
//   - streaming (RP2040, 264 KB): segments go from the socket straight into
//     the controller's data RAM; the hash is computed on the way through and
//     an unchanged frame ends without the refresh command.
#ifndef PK_RENDER_H
#define PK_RENDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef PK_FRAMEBUFFER_BYTES
#if PICO_RP2350
#define PK_FRAMEBUFFER_BYTES 192000u // 800x480 at 4bpp, the largest panel here
#else
#define PK_FRAMEBUFFER_BYTES 0u
#endif
#endif

typedef enum {
    PK_RENDER_DONE = 0,       // the panel shows the new frame
    PK_RENDER_UNCHANGED,      // fetched, identical to what is shown: no refresh
    PK_RENDER_RETRY_LATER,    // the backend's render queue is full (503)
    PK_RENDER_FAILED,
    PK_RENDER_NOT_CONFIGURED, // no backend / panel / Wi-Fi
} pk_render_result_t;

typedef struct {
    uint32_t count;           // panel refreshes, persisted across power cuts
    uint32_t passes;          // render passes since boot
    uint32_t last_ms;
    bool last_refresh_skipped;
    bool busy;
    char last_error[96];
} pk_render_stats_t;

void pk_render_init(void);
// `retry_after_seconds` is set for PK_RENDER_RETRY_LATER.
pk_render_result_t pk_render_once(uint32_t *retry_after_seconds);
const pk_render_stats_t *pk_render_stats(void);
// True while the glass holds a rendered frame (not a status screen, not
// factory-blank) — survives power cuts.
bool pk_render_panel_shows_scene(void);

// Status screens, drawn from the row generator (pk_status_screen.c). Each is
// skipped when the panel already shows that exact screen.
void pk_render_show_portal_screen(const char *ssid, const char *psk, const char *ip);
void pk_render_show_message(const char *status, const char *line1, const char *line2,
                            const char *line3);

// The packed frame on the glass, when this build keeps one (buffered mode
// and at least one successful render since boot). NULL otherwise.
const uint8_t *pk_render_framebuffer(int *format, int *width, int *height);

// GET …/embedded/settings (ETag'd) → config. Cheap in steady state (304).
void pk_render_sync_settings(void);
// POST the log ring to {backend}/api/log in batches.
void pk_render_flush_logs(void);

#endif // PK_RENDER_H
