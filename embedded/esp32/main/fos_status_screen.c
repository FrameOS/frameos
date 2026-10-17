#include "fos_status_screen.h"
#include "fos_framebuffer.h"
#include "fos_logo_bitmap.h"
#include "fos_panel_draw.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

#include "frameos_display.h"

static const char *TAG = "fos_status";

/* The FrameOS mark, `scale` panel pixels per bitmap pixel. */
static void draw_mark(const fos_panel_surface_t *s, int x, int y, int scale)
{
    for (int row = 0; row < FOS_LOGO_H; row++) {
        uint32_t bits = FOS_LOGO_ROWS[row];
        for (int col = 0; col < FOS_LOGO_W; col++) {
            if (bits & (1u << (FOS_LOGO_W - 1 - col))) {
                fos_panel_fill_rect(s, x + col * scale, y + row * scale, scale, scale, true);
            }
        }
    }
}

/* The header every FrameOS status screen shares (frameos/utils/status_screen.nim
 * draws the same thing with pixie): the mark, "FrameOS" beside it, and one
 * status line under the wordmark. Returns the y just below the header. */
static int draw_header(const fos_panel_surface_t *s, int x, int y, int scale, const char *status)
{
    int title_scale = scale + 1;
    int title_h = 7 * title_scale;
    int status_h = 7 * scale;
    int text_h = title_h + scale * 2 + status_h;
    int mark_scale = text_h >= FOS_LOGO_H * 2 ? 2 : 1;
    int mark_h = FOS_LOGO_H * mark_scale;
    int header_h = mark_h > text_h ? mark_h : text_h;

    draw_mark(s, x, y + (header_h - mark_h) / 2, mark_scale);
    int text_x = x + FOS_LOGO_W * mark_scale + scale * 4;
    int text_y = y + (header_h - text_h) / 2;
    fos_panel_draw_text(s, "FrameOS", text_x, text_y, title_scale);
    fos_panel_draw_text(s, status, text_x, text_y + title_h + scale * 2,
                        fos_panel_fit_scale(status, scale, s->width - text_x - x));
    return y + header_h;
}

esp_err_t fos_status_screen_show_portal(const char *ssid, const char *psk, const char *ip)
{
    if (!fos_display_present()) return ESP_ERR_INVALID_STATE;

    int width = fos_display_width();
    int height = fos_display_height();
    fos_pixel_format_t format = fos_display_format();
    size_t len = fos_display_buffer_size();
    uint8_t *buf = fos_framebuffer_acquire(len);
    if (!buf) {
        ESP_LOGE(TAG, "out of memory for %u byte status screen", (unsigned)len);
        return ESP_ERR_NO_MEM;
    }
    memset(buf, fos_panel_white_fill(format), len);
    /* Panel orientation: the portal screen predates the rotation setting
     * and a frame on the portal has not been told one yet. */
    const fos_panel_surface_t surface = {
        .buf = buf, .width = width, .height = height, .format = format, .rotate = 0,
    };

    int scale = width >= 700 && height >= 400 ? 4 : width >= 400 ? 3 : 2;
    int margin = width / 16 < 12 ? 12 : width / 16;
    int gap = scale * 4;

    char ssid_line[48];
    char psk_line[80];
    char ip_line[64];
    snprintf(ssid_line, sizeof(ssid_line), "Wi-Fi: %s", ssid && ssid[0] ? ssid : "FrameOS");
    snprintf(psk_line, sizeof(psk_line), "Password: %s", psk && psk[0] ? psk : "(none)");
    snprintf(ip_line, sizeof(ip_line), "then open http://%s/", ip && ip[0] ? ip : "192.168.4.1");

    int avail = width - 2 * margin;
    const char *hint = "Join this network from your phone or laptop";
    int y = draw_header(&surface, margin, margin, scale, "Setup: not on a network yet");
    y += gap * 2;
    int hint_scale = fos_panel_fit_scale(hint, scale, avail);
    fos_panel_draw_text(&surface, hint, margin, y, hint_scale);
    y += 7 * hint_scale + gap;
    int ssid_scale = fos_panel_fit_scale(ssid_line, scale + 1, avail);
    fos_panel_draw_text(&surface, ssid_line, margin, y, ssid_scale);
    y += 7 * ssid_scale + gap;
    int psk_scale = fos_panel_fit_scale(psk_line, scale + 1, avail);
    fos_panel_draw_text(&surface, psk_line, margin, y, psk_scale);
    y += 7 * psk_scale + gap;
    fos_panel_draw_text(&surface, ip_line, margin, y, fos_panel_fit_scale(ip_line, scale, avail));

    esp_err_t err = fos_display_blit(buf, len);
    fos_framebuffer_release(buf);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "portal status screen rendered: ssid=%s ip=%s",
                 ssid_line, ip && ip[0] ? ip : "192.168.4.1");
    } else {
        ESP_LOGW(TAG, "portal status screen failed: %s", esp_err_to_name(err));
    }
    return err;
}
