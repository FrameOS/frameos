/* The provisioning portal's screen. See fos_portal_screen.h. */
#include "fos_portal_screen.h"
#include "fos_logo_bitmap.h"

#include <stdio.h>
#include <string.h>

#define QUIET 2       /* modules of white around a code */
#define MAX_LINES 4

static int max_int(int a, int b) { return a > b ? a : b; }
static int min_int(int a, int b) { return a < b ? a : b; }

bool fos_portal_wifi_code(const char *ssid, const char *psk, char *out, int out_len)
{
    if (out == NULL || out_len <= 0) return false;
    int n = 0;
    bool ok = true;
#define ADD(c)                              \
    do {                                    \
        if (n + 1 < out_len) out[n++] = (c); \
        else ok = false;                    \
    } while (0)
    const bool open = psk == NULL || psk[0] == '\0';
    const char *head = open ? "WIFI:T:nopass;S:" : "WIFI:T:WPA;S:";
    for (const char *p = head; *p; p++) ADD(*p);
    for (int part = 0; part < (open ? 1 : 2); part++) {
        if (part == 1) {
            for (const char *p = ";P:"; *p; p++) ADD(*p);
        }
        for (const char *p = part == 0 ? (ssid ? ssid : "") : psk; *p; p++) {
            if (strchr("\\;,:\"", *p) != NULL) ADD('\\');
            ADD(*p);
        }
    }
    ADD(';');
    ADD(';');
#undef ADD
    out[n] = '\0';
    return ok;
}

/* --------------------------------------------------------------- drawing */

typedef struct {
    const fos_panel_surface_t *s;
    bool dark; /* white on black */
} pen_t;

static void ink_rect(const pen_t *pen, int x, int y, int w, int h)
{
    fos_panel_fill_rect(pen->s, x, y, w, h, !pen->dark);
}

static void ink_text(const pen_t *pen, const char *text, int x, int y, int scale)
{
    fos_panel_draw_text_ink(pen->s, text, x, y, scale, !pen->dark);
}

/* The FrameOS mark, `scale` panel pixels per bitmap pixel. */
static void draw_mark(const pen_t *pen, int x, int y, int scale)
{
    for (int row = 0; row < FOS_LOGO_H; row++) {
        uint32_t bits = FOS_LOGO_ROWS[row];
        for (int col = 0; col < FOS_LOGO_W; col++) {
            if (bits & (1u << (FOS_LOGO_W - 1 - col))) {
                ink_rect(pen, x + col * scale, y + row * scale, scale, scale);
            }
        }
    }
}

/* The header every FrameOS status screen shares (frameos/utils/status_screen.nim
 * draws the same with pixie): the mark, "FrameOS" beside it and one status
 * line under the wordmark, centred, no further left than `x`. Measured
 * (`pen` NULL) or drawn; returns its height, its width in `*width`. */
static int header(const pen_t *pen, int sw, int x, int y, int scale, const char *status, int *width)
{
    const int title_scale = scale + 1;
    const int title_h = 7 * title_scale;
    const int status_h = 7 * scale;
    const int text_h = title_h + scale * 2 + status_h;
    const int mark_scale = max_int(1, (text_h + FOS_LOGO_H / 2) / FOS_LOGO_H);
    const int mark_h = FOS_LOGO_H * mark_scale;
    const int header_h = max_int(mark_h, text_h);
    const int mark_w = FOS_LOGO_W * mark_scale + scale * 4;
    const int status_scale = fos_panel_fit_scale(status, scale, sw - 2 * x - mark_w);
    const int text_w = max_int(fos_panel_text_width("FrameOS", title_scale),
                               fos_panel_text_width(status, status_scale));
    if (width) *width = mark_w + text_w;
    if (pen != NULL) {
        x = max_int(x, (sw - mark_w - text_w) / 2);
        draw_mark(pen, x, y + (header_h - mark_h) / 2, mark_scale);
        const int text_y = y + (header_h - text_h) / 2;
        ink_text(pen, "FrameOS", x + mark_w, text_y, title_scale);
        ink_text(pen, status, x + mark_w, text_y + title_h + scale * 2, status_scale);
    }
    return header_h;
}

static const char STATUS[] = "Set up Wi-Fi with your phone";

/* ------------------------------------------------------------ the layout */

typedef struct {
    const char *lines[MAX_LINES];
    int count;
} caption_t;

typedef struct {
    fos_portal_screen_layout_t arrangement;
    bool header;
    int header_scale;
    int header_y;
    int scale;  /* caption text */
    int x, y, w, h; /* the area under the header */
    int card_w, card_h;
    int unit[2];
    int extent; /* the larger code's side, quiet zone included */
    caption_t captions[2];
} plan_t;

static int caption_height(const caption_t *c, int scale)
{
    return c->count > 0 ? c->count * 10 * scale - 3 * scale : 0;
}

/* Every line fits `w` at `scale`: the captions are one size. */
static bool caption_fits(const caption_t *c, int w, int scale)
{
    for (int i = 0; i < c->count; i++) {
        if (fos_panel_text_width(c->lines[i], scale) > w) return false;
    }
    return true;
}

typedef struct {
    const char *ssid_line;
    const char *psk_line;   /* "Password: …", NULL for an open hotspot */
    const char *psk_value;  /* the passphrase alone, when the line above is split */
    const char *url_line;
    const char *ip;         /* the address alone, for a card too narrow for the URL */
} texts_t;

/* The captions for cards `card_w` wide at `scale`: the password goes under
 * its label when "Password: …" is wider than the card. */
static void captions_for(const texts_t *t, int card_w, int scale, caption_t out[2])
{
    caption_t *wifi = &out[0];
    wifi->count = 0;
    wifi->lines[wifi->count++] = "1. Join the Wi-Fi";
    wifi->lines[wifi->count++] = t->ssid_line;
    if (t->psk_line != NULL) {
        if (fos_panel_text_width(t->psk_line, scale) <= card_w) {
            wifi->lines[wifi->count++] = t->psk_line;
        } else {
            wifi->lines[wifi->count++] = "Password:";
            wifi->lines[wifi->count++] = t->psk_value;
        }
    }
    caption_t *page = &out[1];
    page->count = 0;
    page->lines[page->count++] = "2. Then open";
    page->lines[page->count++] = fos_panel_text_width(t->url_line, scale) <= card_w ? t->url_line : t->ip;
}

/* The codes as large as `arrangement` lets them be at `scale`; false when a
 * caption does not fit or a module would be under two pixels. */
static bool try_plan(plan_t *plan, fos_portal_screen_layout_t arrangement, const texts_t *t,
                     const fos_qr_t codes[2], int scale)
{
    const int gutter = max_int(plan->h, plan->w) / 20;
    plan->arrangement = arrangement;
    plan->scale = scale;
    if (arrangement == FOS_PORTAL_SCREEN_COLUMNS) {
        plan->card_w = (plan->w - gutter) / 2;
        plan->card_h = plan->h;
    } else {
        plan->card_w = plan->w;
        plan->card_h = (plan->h - gutter) / 2;
    }
    captions_for(t, plan->card_w, scale, plan->captions);
    if (!caption_fits(&plan->captions[0], plan->card_w, scale) ||
        !caption_fits(&plan->captions[1], plan->card_w, scale)) {
        return false;
    }
    const int caption_h = max_int(caption_height(&plan->captions[0], scale),
                                  caption_height(&plan->captions[1], scale));
    const int tile = min_int(plan->card_w, plan->card_h - caption_h - 3 * scale);
    plan->extent = 0;
    for (int i = 0; i < 2; i++) {
        plan->unit[i] = tile / (codes[i].size + 2 * QUIET);
        if (plan->unit[i] < 2) return false;
        plan->extent = max_int(plan->extent, plan->unit[i] * (codes[i].size + 2 * QUIET));
    }
    return true;
}

/* The plan for the rectangle (ax, ay, aw, ah), with or without the header:
 * the codes first, the largest caption whose codes are within a fifth of
 * the largest the arrangement gives (so captions do not shrink to scale 1
 * for a few pixels of code). False when no code a phone reads fits. */
static bool plan_area(plan_t *best, int sw, int small, int ax, int ay, int aw, int ah, bool with_header,
                      const texts_t *t, const fos_qr_t codes[2])
{
    const int base_scale = max_int(1, min_int(6, small / 150));
    const int header_scale = max_int(1, min_int(5, small / 160));
    const fos_portal_screen_layout_t arrangements[2] = {FOS_PORTAL_SCREEN_COLUMNS, FOS_PORTAL_SCREEN_ROWS};
    int header_w = 0;
    const int header_h = header(NULL, sw, ax, 0, header_scale, STATUS, &header_w);
    if (with_header && header_w > aw) return false;
    plan_t candidates[2 * 6];
    int count = 0;
    for (int scale = base_scale; scale >= 1; scale--) {
        plan_t plan = {0};
        plan.header = with_header;
        plan.header_scale = header_scale;
        plan.header_y = ay;
        plan.x = ax;
        plan.y = ay + (with_header ? header_h + small / 40 : 0);
        plan.w = aw;
        plan.h = ay + ah - plan.y;
        if (plan.w <= 0 || plan.h <= 0) continue;
        for (int a = 0; a < 2; a++) {
            plan_t candidate = plan;
            if (!try_plan(&candidate, arrangements[a], t, codes, scale)) continue;
            candidates[count++] = candidate;
        }
    }
    if (count == 0) return false;
    /* The arrangement that suits the rectangle's shape unless the other's
     * codes come out a tenth larger (two codes side by side on a tall panel
     * leave half of it empty); then the caption size within it. */
    fos_portal_screen_layout_t arrangement = aw >= ah ? FOS_PORTAL_SCREEN_COLUMNS : FOS_PORTAL_SCREEN_ROWS;
    int largest_of[3] = {0, 0, 0};
    for (int i = 0; i < count; i++) {
        largest_of[candidates[i].arrangement] = max_int(largest_of[candidates[i].arrangement], candidates[i].extent);
    }
    const fos_portal_screen_layout_t other =
        arrangement == FOS_PORTAL_SCREEN_COLUMNS ? FOS_PORTAL_SCREEN_ROWS : FOS_PORTAL_SCREEN_COLUMNS;
    if (largest_of[other] * 10 > largest_of[arrangement] * 11) arrangement = other;
    const int largest = largest_of[arrangement];
    int pick = -1;
    for (int i = 0; i < count; i++) {
        if (candidates[i].arrangement != arrangement || candidates[i].extent * 5 < largest * 4) continue;
        if (pick < 0 || candidates[i].scale > candidates[pick].scale) pick = i;
    }
    *best = candidates[pick];
    return true;
}

/* The header only if the codes are readable with it. On a round panel
 * everything stays inside a rectangle inscribed in its circle, of the shape
 * that gives the largest codes, in the middle of the circle. */
static bool make_plan(plan_t *best, const fos_panel_surface_t *s, const texts_t *t, const fos_qr_t codes[2],
                      bool round)
{
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    const int small = min_int(sw, sh);
    const int margin = max_int(6, small / 20);
    /* Width and height of a rectangle in a circle of diameter 1000, at
     * aspects 2, 1.6, 1.3 and 1 (a square last). */
    static const int16_t INSCRIBED[4][2] = {{894, 447}, {848, 530}, {793, 610}, {707, 707}};
    const int diameter = small - 2 * max_int(12, margin / 2); /* clear of the bezel */
    for (int with_header = 1; with_header >= 0; with_header--) {
        if (!round) {
            if (plan_area(best, sw, small, margin, margin, sw - 2 * margin, sh - 2 * margin, with_header, t,
                          codes)) {
                return true;
            }
            continue;
        }
        bool found = false;
        for (int i = 0; i < 4; i++) {
            const int aw = diameter * INSCRIBED[i][0] / 1000;
            const int ah = diameter * INSCRIBED[i][1] / 1000;
            plan_t plan;
            if (plan_area(&plan, sw, small, (sw - aw) / 2, (sh - ah) / 2, aw, ah, with_header, t, codes) &&
                (!found || plan.extent > best->extent)) {
                *best = plan;
                found = true;
            }
        }
        if (!found) continue;
        /* In the middle of the circle: the room left under the captions,
         * half of it above the content instead. */
        const int caption_h = max_int(caption_height(&best->captions[0], best->scale),
                                      caption_height(&best->captions[1], best->scale));
        const int slack = (best->card_h - (best->extent + 3 * best->scale + caption_h)) / 2;
        const int top = best->header ? best->header_y : best->y + slack;
        const int bottom = best->y + best->h - slack;
        const int shift = (sh - bottom - top) / 2;
        if (shift > 0) {
            best->header_y += shift;
            best->y += shift;
        }
        return true;
    }
    return false;
}

static void draw_code(const pen_t *pen, const fos_qr_t *qr, int x, int y, int unit)
{
    const int side = unit * (qr->size + 2 * QUIET);
    /* White under the code on either screen: a light-on-dark code is one
     * not every phone reads. */
    fos_panel_fill_rect(pen->s, x, y, side, side, false);
    const int origin_x = x + unit * QUIET;
    const int origin_y = y + unit * QUIET;
    for (int my = 0; my < qr->size; my++) {
        for (int mx = 0; mx < qr->size;) {
            if (!fos_qr_dark(qr, mx, my)) {
                mx++;
                continue;
            }
            int run = 1; /* a row's dark run as one rectangle */
            while (mx + run < qr->size && fos_qr_dark(qr, mx + run, my)) run++;
            fos_panel_fill_rect(pen->s, origin_x + mx * unit, origin_y + my * unit, run * unit, unit, true);
            mx += run;
        }
    }
}

static void draw_plan(const pen_t *pen, const plan_t *plan, const fos_qr_t codes[2])
{
    const int sw = fos_panel_scene_width(pen->s);
    const int scale = plan->scale;
    if (plan->header) {
        header(pen, sw, plan->x, plan->header_y, plan->header_scale, STATUS, NULL);
    }
    const int gap = 3 * scale;
    const int caption_h = max_int(caption_height(&plan->captions[0], scale),
                                  caption_height(&plan->captions[1], scale));
    const int block_h = plan->extent + gap + caption_h;
    for (int i = 0; i < 2; i++) {
        int card_x = plan->x;
        int card_y = plan->y;
        if (plan->arrangement == FOS_PORTAL_SCREEN_COLUMNS) {
            card_x += i * (plan->w - plan->card_w);
        } else {
            card_y += i * (plan->h - plan->card_h);
        }
        const int top = card_y + (plan->card_h - block_h) / 2;
        const int side = plan->unit[i] * (codes[i].size + 2 * QUIET);
        draw_code(pen, &codes[i], card_x + (plan->card_w - side) / 2, top + (plan->extent - side) / 2,
                  plan->unit[i]);
        int y = top + plan->extent + gap;
        const caption_t *c = &plan->captions[i];
        for (int l = 0; l < c->count; l++) {
            const int line_w = fos_panel_text_width(c->lines[l], scale);
            ink_text(pen, c->lines[l], card_x + (plan->card_w - line_w) / 2, y, scale);
            y += 10 * scale;
        }
    }
}

/* No room for a code a phone reads: the facts as lines (a 72x40 OLED). */
static void draw_text_only(const pen_t *pen, const texts_t *t)
{
    const int sw = fos_panel_scene_width(pen->s);
    const int sh = fos_panel_scene_height(pen->s);
    const int scale = sw >= 700 && sh >= 400 ? 4 : sw >= 400 ? 3 : 2;
    const int margin = max_int(2, min_int(12, sw / 16));
    const int avail = sw - 2 * margin;
    const int gap = scale * 2;
    int y = margin;
    if (header(NULL, sw, margin, 0, scale, STATUS, NULL) * 3 < sh) {
        y += header(pen, sw, margin, margin, scale, STATUS, NULL) + gap * 2;
    }
    const char *lines[4] = {"Join the Wi-Fi", t->ssid_line, t->psk_line, NULL};
    char open_line[80];
    snprintf(open_line, sizeof(open_line), "then open %s", t->url_line);
    lines[3] = open_line;
    for (int i = 0; i < 4; i++) {
        if (lines[i] == NULL) continue;
        const int line_scale = fos_panel_fit_scale(lines[i], i == 1 ? scale + 1 : scale, avail);
        ink_text(pen, lines[i], margin, y, line_scale);
        y += 7 * line_scale + gap;
    }
}

fos_portal_screen_layout_t fos_portal_screen_draw(const fos_panel_surface_t *s, const char *ssid,
                                                  const char *psk, const char *ip, bool dark, bool round,
                                                  fos_qr_t scratch[2])
{
    if (s == NULL || s->buf == NULL) return FOS_PORTAL_SCREEN_TEXT;
    const int sw = fos_panel_scene_width(s);
    const int sh = fos_panel_scene_height(s);
    const pen_t pen = {.s = s, .dark = dark};
    fos_panel_fill_rect(s, 0, 0, sw, sh, dark);

    const bool has_psk = psk != NULL && psk[0] != '\0';
    char psk_line[96];
    char url_line[64];
    snprintf(psk_line, sizeof(psk_line), "Password: %s", has_psk ? psk : "");
    const char *address = ip && ip[0] ? ip : "192.168.4.1";
    snprintf(url_line, sizeof(url_line), "http://%s/", address);
    const texts_t texts = {
        .ssid_line = ssid && ssid[0] ? ssid : "FrameOS",
        .psk_line = has_psk ? psk_line : NULL,
        .psk_value = has_psk ? psk : NULL,
        .url_line = url_line,
        .ip = address,
    };

    char wifi_code[200];
    plan_t plan;
    if (scratch != NULL && fos_portal_wifi_code(texts.ssid_line, psk, wifi_code, sizeof(wifi_code)) &&
        fos_qr_encode(wifi_code, &scratch[0]) && fos_qr_encode(url_line, &scratch[1]) &&
        make_plan(&plan, s, &texts, scratch, round)) {
        draw_plan(&pen, &plan, scratch);
        return plan.arrangement;
    }
    draw_text_only(&pen, &texts);
    return FOS_PORTAL_SCREEN_TEXT;
}
