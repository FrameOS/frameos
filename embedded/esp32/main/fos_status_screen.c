#include "fos_status_screen.h"
#include "fos_framebuffer.h"
#include "fos_font5x7.h"
#include "fos_logo_bitmap.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

#include "frameos_display.h"

static const char *TAG = "fos_status";

static uint8_t white_fill(fos_pixel_format_t format)
{
    switch (format) {
        case FOS_PIXEL_2BPP_BWYR:
            return 0x55; /* palette index 1 (white) */
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
            return 0x11; /* palette index 1 (white) */
        default:
            return 0xFF;
    }
}

static void set_black_pixel(uint8_t *buf, int width, int height, fos_pixel_format_t format, int x, int y)
{
    if (!buf || x < 0 || y < 0 || x >= width || y >= height) return;
    switch (format) {
        case FOS_PIXEL_1BPP: {
            size_t row = ((size_t)width + 7u) / 8u;
            buf[(size_t)y * row + (size_t)(x / 8)] &= (uint8_t)~(0x80u >> (x & 7));
            break;
        }
        case FOS_PIXEL_DUAL_1BPP_RED:
        case FOS_PIXEL_DUAL_1BPP_YELLOW: {
            size_t row = ((size_t)width + 7u) / 8u;
            buf[(size_t)y * row + (size_t)(x / 8)] &= (uint8_t)~(0x80u >> (x & 7));
            break;
        }
        case FOS_PIXEL_2BPP_GRAY:
        case FOS_PIXEL_2BPP_BWYR: {
            size_t row = ((size_t)width + 3u) / 4u;
            size_t index = (size_t)y * row + (size_t)(x / 4);
            uint8_t shift = (uint8_t)(6 - (x & 3) * 2);
            buf[index] &= (uint8_t)~(0x03u << shift);
            break;
        }
        case FOS_PIXEL_4BPP_7COLOR:
        case FOS_PIXEL_4BPP_SPECTRA6:
        case FOS_PIXEL_4BPP_GRAY: {
            size_t row = ((size_t)width + 1u) / 2u;
            size_t index = (size_t)y * row + (size_t)(x / 2);
            uint8_t mask = (x & 1) == 0 ? 0x0Fu : 0xF0u;
            buf[index] &= mask;
            break;
        }
        default:
            break;
    }
}

static int text_width(const char *text, int scale)
{
    if (!text || scale <= 0) return 0;
    int chars = (int)strlen(text);
    return chars > 0 ? ((chars * 6) - 1) * scale : 0;
}

static void draw_rect(uint8_t *buf, int width, int height, fos_pixel_format_t format,
                      int x, int y, int w, int h)
{
    for (int yy = 0; yy < h; yy++) {
        for (int xx = 0; xx < w; xx++) {
            set_black_pixel(buf, width, height, format, x + xx, y + yy);
        }
    }
}

static void draw_char(uint8_t *buf, int width, int height, fos_pixel_format_t format,
                      char c, int x, int y, int scale)
{
    const uint8_t *rows = fos_font5x7_glyph(c);
    if (!rows) return;
    for (int row = 0; row < 7; row++) {
        for (int col = 0; col < 5; col++) {
            if (rows[row] & (0x10u >> col)) {
                draw_rect(buf, width, height, format,
                          x + col * scale, y + row * scale, scale, scale);
            }
        }
    }
}

static void draw_text(uint8_t *buf, int width, int height, fos_pixel_format_t format,
                      const char *text, int x, int y, int scale)
{
    if (!text || scale <= 0) return;
    for (size_t i = 0; text[i]; i++) {
        draw_char(buf, width, height, format, text[i], x + (int)i * 6 * scale, y, scale);
    }
}

/* The largest scale (at most `scale`) at which `text` fits in `avail` px. */
static int fit_scale(const char *text, int scale, int avail)
{
    while (scale > 1 && text_width(text, scale) > avail) {
        scale--;
    }
    return scale;
}

/* The FrameOS mark, `scale` panel pixels per bitmap pixel. */
static void draw_mark(uint8_t *buf, int width, int height, fos_pixel_format_t format,
                      int x, int y, int scale)
{
    for (int row = 0; row < FOS_LOGO_H; row++) {
        uint32_t bits = FOS_LOGO_ROWS[row];
        for (int col = 0; col < FOS_LOGO_W; col++) {
            if (bits & (1u << (FOS_LOGO_W - 1 - col))) {
                draw_rect(buf, width, height, format,
                          x + col * scale, y + row * scale, scale, scale);
            }
        }
    }
}

/* The header every FrameOS status screen shares (frameos/utils/status_screen.nim
 * draws the same thing with pixie): the mark, "FrameOS" beside it, and one
 * status line under the wordmark. Returns the y just below the header. */
static int draw_header(uint8_t *buf, int width, int height, fos_pixel_format_t format,
                       int x, int y, int scale, const char *status)
{
    int title_scale = scale + 1;
    int title_h = 7 * title_scale;
    int status_h = 7 * scale;
    int text_h = title_h + scale * 2 + status_h;
    int mark_scale = text_h >= FOS_LOGO_H * 2 ? 2 : 1;
    int mark_h = FOS_LOGO_H * mark_scale;
    int header_h = mark_h > text_h ? mark_h : text_h;

    draw_mark(buf, width, height, format, x, y + (header_h - mark_h) / 2, mark_scale);
    int text_x = x + FOS_LOGO_W * mark_scale + scale * 4;
    int text_y = y + (header_h - text_h) / 2;
    draw_text(buf, width, height, format, "FrameOS", text_x, text_y, title_scale);
    draw_text(buf, width, height, format, status, text_x, text_y + title_h + scale * 2,
              fit_scale(status, scale, width - text_x - x));
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
    memset(buf, white_fill(format), len);

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
    int y = draw_header(buf, width, height, format, margin, margin, scale, "Setup: not on a network yet");
    y += gap * 2;
    int hint_scale = fit_scale(hint, scale, avail);
    draw_text(buf, width, height, format, hint, margin, y, hint_scale);
    y += 7 * hint_scale + gap;
    int ssid_scale = fit_scale(ssid_line, scale + 1, avail);
    draw_text(buf, width, height, format, ssid_line, margin, y, ssid_scale);
    y += 7 * ssid_scale + gap;
    int psk_scale = fit_scale(psk_line, scale + 1, avail);
    draw_text(buf, width, height, format, psk_line, margin, y, psk_scale);
    y += 7 * psk_scale + gap;
    draw_text(buf, width, height, format, ip_line, margin, y, fit_scale(ip_line, scale, avail));

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
