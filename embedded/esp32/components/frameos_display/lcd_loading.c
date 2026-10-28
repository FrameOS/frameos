#include "lcd_loading.h"

#include <string.h>

static uint16_t *at(const fos_lcd_loading_t *m, uint16_t *fb)
{
    return fb + (size_t)m->rect.y * (size_t)m->width + (size_t)m->rect.x;
}

/* The pixels under the mark, between the panel's buffer and `saved`. */
static void copy_rect(const fos_lcd_loading_t *m, uint16_t *fb, bool to_panel)
{
    uint16_t *panel = at(m, fb);
    size_t row_bytes = (size_t)m->rect.w * sizeof(uint16_t);
    for (int32_t y = 0; y < m->rect.h; y++) {
        uint16_t *panel_row = panel + (size_t)y * (size_t)m->width;
        uint16_t *saved_row = m->saved + (size_t)y * (size_t)m->rect.w;
        if (to_panel) memcpy(panel_row, saved_row, row_bytes);
        else memcpy(saved_row, panel_row, row_bytes);
    }
}

static uint16_t *put_back(fos_lcd_loading_t *m)
{
    uint16_t *fb = m->drawn_in;
    if (!fb) return NULL;
    copy_rect(m, fb, true);
    m->drawn_in = NULL;
    return fb;
}

bool fos_lcd_loading_begin(fos_lcd_loading_t *m, const fos_lcd_loading_rect_t *rect, int64_t since_us)
{
    if (!m || !rect) return false;
    bool same = rect->x == m->rect.x && rect->y == m->rect.y && rect->w == m->rect.w && rect->h == m->rect.h;
    if (m->drawn_in && !same) put_back(m);
    if (rect->w <= 0 || rect->h <= 0 || rect->x < 0 || rect->y < 0 || rect->x + rect->w > m->width ||
        rect->y + rect->h > m->height || !m->saved || !m->draw ||
        (size_t)rect->w * (size_t)rect->h > m->saved_words) {
        m->active = false;
        return false;
    }
    m->rect = *rect;
    if (!m->active) {
        m->active = true;
        m->since_us = since_us;
        m->frames = 0;
    }
    return true;
}

int64_t fos_lcd_loading_step(fos_lcd_loading_t *m, uint16_t *scanned, int64_t now_us,
                             uint16_t **wrote, uint16_t **restored)
{
    if (wrote) *wrote = NULL;
    if (restored) *restored = NULL;
    if (!m) return -1;
    if (!m->active) {
        uint16_t *fb = put_back(m);
        if (restored) *restored = fb;
        return -1;
    }
    int64_t elapsed_ms = (now_us - m->since_us) / 1000;
    if (elapsed_ms >= FOS_LCD_LOADING_MAX_MS) {
        m->active = false;
        uint16_t *fb = put_back(m);
        if (restored) *restored = fb;
        return -1;
    }
    if (elapsed_ms < FOS_LCD_LOADING_DELAY_MS) {
        return (FOS_LCD_LOADING_DELAY_MS - elapsed_ms) * 1000;
    }
    if (!scanned) return (int64_t)FOS_LCD_LOADING_FRAME_MS * 1000;
    if (m->drawn_in && m->drawn_in != scanned) {
        /* A picture went up in between (not this switch's: that ends it). */
        uint16_t *fb = put_back(m);
        if (restored) *restored = fb;
    }
    if (!m->drawn_in) {
        copy_rect(m, scanned, false);
        m->drawn_in = scanned;
    }
    int32_t stride = (int32_t)((size_t)m->width * sizeof(uint16_t));
    m->draw((int32_t)(elapsed_ms - FOS_LCD_LOADING_DELAY_MS), &m->rect, m->saved,
            (int32_t)((size_t)m->rect.w * sizeof(uint16_t)), at(m, scanned), stride);
    m->frames++;
    if (wrote) *wrote = scanned;
    return (int64_t)FOS_LCD_LOADING_FRAME_MS * 1000;
}

uint16_t *fos_lcd_loading_end(fos_lcd_loading_t *m, int64_t now_us)
{
    if (!m) return NULL;
    if (m->active && m->frames > 0) {
        int64_t ms = (now_us - m->since_us) / 1000;
        m->shown_ms = ms > INT32_MAX ? INT32_MAX : (int32_t)ms;
    }
    m->active = false;
    m->frames = 0;
    return put_back(m);
}

int32_t fos_lcd_loading_take_shown_ms(fos_lcd_loading_t *m)
{
    if (!m) return -1;
    int32_t ms = m->shown_ms;
    m->shown_ms = -1;
    return ms;
}
