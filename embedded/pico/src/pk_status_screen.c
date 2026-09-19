#include "pk_status_screen.h"

#include <stdio.h>
#include <string.h>

#include "fos_font5x7.h"
#include "fos_logo_bitmap.h"
#include "pk_fosb.h"

static int text_width(const char *text, int scale)
{
    int chars = (int)strlen(text);
    return chars > 0 ? ((chars * 6) - 1) * scale : 0;
}

// The largest scale (at most `scale`) at which `text` fits in `avail` px.
static int fit_scale(const char *text, int scale, int avail)
{
    while (scale > 1 && text_width(text, scale) > avail) scale--;
    return scale;
}

static void add_item(pk_status_screen_t *screen, const char *text, int x, int y, int scale)
{
    if (screen->item_count >= PK_STATUS_MAX_ITEMS || text == NULL || text[0] == '\0') return;
    pk_status_item_t *item = &screen->items[screen->item_count++];
    snprintf(item->text, sizeof(item->text), "%s", text);
    item->x = x;
    item->y = y;
    item->scale = scale;
}

typedef struct {
    int scale;
    int margin;
    int gap;
    int avail;
} layout_t;

static layout_t begin(pk_status_screen_t *screen, int width, int height, int format)
{
    memset(screen, 0, sizeof(*screen));
    screen->width = width;
    screen->height = height;
    screen->format = format;
    layout_t layout;
    layout.scale = width >= 700 && height >= 400 ? 4 : width >= 400 ? 3 : 2;
    layout.margin = width / 16 < 12 ? 12 : width / 16;
    layout.gap = layout.scale * 4;
    layout.avail = width - 2 * layout.margin;
    return layout;
}

// The header every FrameOS status screen shares: the mark, "FrameOS" beside
// it, and one status line under the wordmark. Returns the y just below it.
static int add_header(pk_status_screen_t *screen, const layout_t *layout, const char *status)
{
    int x = layout->margin;
    int y = layout->margin;
    int scale = layout->scale;
    int title_scale = scale + 1;
    int title_h = 7 * title_scale;
    int status_h = 7 * scale;
    int text_h = title_h + scale * 2 + status_h;
    int mark_scale = text_h >= FOS_LOGO_H * 2 ? 2 : 1;
    int mark_h = FOS_LOGO_H * mark_scale;
    int header_h = mark_h > text_h ? mark_h : text_h;

    screen->mark_x = x;
    screen->mark_y = y + (header_h - mark_h) / 2;
    screen->mark_scale = mark_scale;
    int text_x = x + FOS_LOGO_W * mark_scale + scale * 4;
    int text_y = y + (header_h - text_h) / 2;
    add_item(screen, "FrameOS", text_x, text_y, title_scale);
    add_item(screen, status, text_x, text_y + title_h + scale * 2,
             fit_scale(status, scale, screen->width - text_x - x));
    return y + header_h;
}

void pk_status_screen_portal(pk_status_screen_t *screen, int width, int height, int format,
                             const char *ssid, const char *psk, const char *ip)
{
    layout_t layout = begin(screen, width, height, format);
    char ssid_line[PK_STATUS_TEXT_MAX];
    char psk_line[PK_STATUS_TEXT_MAX];
    char ip_line[PK_STATUS_TEXT_MAX];
    snprintf(ssid_line, sizeof(ssid_line), "Wi-Fi: %s", ssid && ssid[0] ? ssid : "FrameOS");
    snprintf(psk_line, sizeof(psk_line), "Password: %s", psk && psk[0] ? psk : "(none)");
    snprintf(ip_line, sizeof(ip_line), "then open http://%s/", ip && ip[0] ? ip : "192.168.4.1");

    const char *hint = "Join this network from your phone or laptop";
    int y = add_header(screen, &layout, "Setup: not on a network yet");
    y += layout.gap * 2;
    int hint_scale = fit_scale(hint, layout.scale, layout.avail);
    add_item(screen, hint, layout.margin, y, hint_scale);
    y += 7 * hint_scale + layout.gap;
    int ssid_scale = fit_scale(ssid_line, layout.scale + 1, layout.avail);
    add_item(screen, ssid_line, layout.margin, y, ssid_scale);
    y += 7 * ssid_scale + layout.gap;
    int psk_scale = fit_scale(psk_line, layout.scale + 1, layout.avail);
    add_item(screen, psk_line, layout.margin, y, psk_scale);
    y += 7 * psk_scale + layout.gap;
    add_item(screen, ip_line, layout.margin, y, fit_scale(ip_line, layout.scale, layout.avail));
}

void pk_status_screen_message(pk_status_screen_t *screen, int width, int height, int format,
                              const char *status, const char *const lines[], int line_count)
{
    layout_t layout = begin(screen, width, height, format);
    int y = add_header(screen, &layout, status ? status : "");
    y += layout.gap * 2;
    for (int i = 0; i < line_count; i++) {
        if (lines[i] == NULL || lines[i][0] == '\0') continue;
        int scale = fit_scale(lines[i], layout.scale, layout.avail);
        add_item(screen, lines[i], layout.margin, y, scale);
        y += 7 * scale + layout.gap;
    }
}

static void black_run(const pk_status_screen_t *screen, uint8_t *row, int x, int w)
{
    for (int xx = x < 0 ? 0 : x; xx < x + w && xx < screen->width; xx++) {
        pk_fosb_row_set_black(row, screen->format, xx);
    }
}

void pk_status_screen_row(const pk_status_screen_t *screen, int y, uint8_t *row)
{
    memset(row, pk_fosb_white_fill(screen->format),
           pk_fosb_row_bytes(screen->format, screen->width));

    if (screen->mark_scale > 0) {
        int mark_row = y - screen->mark_y;
        if (mark_row >= 0 && mark_row < FOS_LOGO_H * screen->mark_scale) {
            uint32_t bits = FOS_LOGO_ROWS[mark_row / screen->mark_scale];
            for (int col = 0; col < FOS_LOGO_W; col++) {
                if (bits & (1u << (FOS_LOGO_W - 1 - col))) {
                    black_run(screen, row, screen->mark_x + col * screen->mark_scale,
                              screen->mark_scale);
                }
            }
        }
    }

    for (int i = 0; i < screen->item_count; i++) {
        const pk_status_item_t *item = &screen->items[i];
        int glyph_row = y - item->y;
        if (item->scale <= 0 || glyph_row < 0 || glyph_row >= 7 * item->scale) continue;
        glyph_row /= item->scale;
        for (size_t c = 0; item->text[c]; c++) {
            const uint8_t *glyph = fos_font5x7_glyph(item->text[c]);
            if (glyph == NULL) continue;
            for (int col = 0; col < 5; col++) {
                if (glyph[glyph_row] & (0x10u >> col)) {
                    black_run(screen, row, item->x + ((int)c * 6 + col) * item->scale,
                              item->scale);
                }
            }
        }
    }
}
