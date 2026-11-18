/* See fos_scene_meta.h. */
#include "fos_scene_meta.h"

#include <string.h>

enum {
    PH_KEY,     /* a member's key comes next (or the closing brace) */
    PH_KEY_STR, /* inside the key */
    PH_COLON,   /* the key is read */
    PH_VALUE,   /* the value comes next */
    PH_STRING,  /* inside a string value */
    PH_LITERAL, /* inside a number, true, false or null */
    PH_AFTER,   /* the value is read: a comma or the closing brace comes */
    PH_SKIP,    /* inside an array or object that is passed over */
};

void fos_scene_meta_begin(fos_scene_meta_t *meta)
{
    /* Not the text: 8 KB a scene, and nothing reads past `len`. */
    meta->text[0] = '\0';
    meta->len = 0;
    meta->mark = 0;
    meta->depth = 0;
    meta->max_depth = 0;
    meta->level = 0;
    meta->phase = PH_KEY;
    meta->key_len = 0;
    meta->in_string = meta->escaped = meta->keeping = meta->whole = meta->failed = false;
    meta->kept[0] = meta->kept[1] = meta->kept[2] = false;
}

/* The member being read is not kept after all: what was copied of it goes. */
static void drop(fos_scene_meta_t *m)
{
    if (!m->keeping) return;
    m->len = m->mark;
    m->keeping = false;
}

static void keep(fos_scene_meta_t *m, char c)
{
    if (!m->keeping) return;
    /* Room for this byte, the braces that close the object and the NUL. */
    if (m->len - m->mark >= FOS_SCENE_META_MEMBER_MAX || m->len + 4 >= FOS_SCENE_META_MAX) {
        drop(m);
        return;
    }
    m->text[m->len++] = c;
}

/* Bytes that belong to no member (the braces) always fit: keep() leaves room. */
static void put(fos_scene_meta_t *m, char c)
{
    m->text[m->len++] = c;
}

static bool is_space(char c)
{
    return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

static void member_done(fos_scene_meta_t *m)
{
    if (m->keeping && (m->phase == PH_AFTER || m->phase == PH_LITERAL)) m->kept[m->level] = true;
    else drop(m);
    m->keeping = false;
}

static void feed(fos_scene_meta_t *m, char c)
{
    if (m->failed || m->whole) {
        if (m->whole && !is_space(c)) m->failed = true; /* more than one value */
        return;
    }
    if (m->depth == 0) {
        if (is_space(c)) return;
        if (c != '{') {
            m->failed = true;
            return;
        }
        m->depth = m->max_depth = m->level = 1;
        m->phase = PH_KEY;
        put(m, '{');
        return;
    }
    if (m->in_string) {
        keep(m, c);
        if (m->escaped) {
            m->escaped = false;
        } else if (c == '\\') {
            m->escaped = true;
            if (m->phase == PH_KEY_STR) m->key_len = 255; /* an escaped key is not the plain "settings" */
        } else if (c == '"') {
            m->in_string = false;
            if (m->phase == PH_KEY_STR) m->phase = PH_COLON;
            else if (m->phase == PH_STRING) m->phase = PH_AFTER;
        } else if (m->phase == PH_KEY_STR && m->level == 1 && m->key_len != 255) {
            if (m->key_len < sizeof(m->key) - 1) m->key[m->key_len++] = c;
            else m->key_len = 255;
        }
        return;
    }
    if (m->depth > m->level) {
        /* An array or object that is passed over: only where it ends. */
        if (c == '"') m->in_string = true;
        else if (c == '{' || c == '[') {
            if (++m->depth > m->max_depth) m->max_depth = m->depth;
        } else if (c == '}' || c == ']') {
            if (--m->depth == m->level) m->phase = PH_AFTER;
        }
        return;
    }
    if (is_space(c)) {
        if (m->phase == PH_LITERAL) m->phase = PH_AFTER;
        return;
    }
    switch (c) {
    case '"':
        if (m->phase == PH_KEY) {
            m->mark = m->len;
            m->keeping = true;
            if (m->kept[m->level]) keep(m, ',');
            keep(m, '"');
            m->phase = PH_KEY_STR;
            m->in_string = true;
            if (m->level == 1) m->key_len = 0;
        } else if (m->phase == PH_VALUE) {
            keep(m, '"');
            m->phase = PH_STRING;
            m->in_string = true;
        } else {
            m->failed = true;
        }
        return;
    case ':':
        if (m->phase != PH_COLON) m->failed = true;
        keep(m, ':');
        m->phase = PH_VALUE;
        return;
    case ',':
        if (m->phase != PH_AFTER && m->phase != PH_LITERAL) m->failed = true;
        member_done(m);
        m->phase = PH_KEY;
        return;
    case '}':
        if (m->phase != PH_KEY) member_done(m);
        if (m->level == 2) {
            /* The settings are read: their member of the scene is whole. */
            put(m, '}');
            m->level = 1;
            m->depth = 1;
            m->keeping = true;
            m->phase = PH_AFTER;
            return;
        }
        put(m, '}');
        m->text[m->len] = '\0';
        m->depth = 0;
        m->whole = true;
        return;
    case '{':
    case '[':
        if (m->phase != PH_VALUE) {
            m->failed = true;
            return;
        }
        if (++m->depth > m->max_depth) m->max_depth = m->depth;
        if (c == '{' && m->level == 1 && m->keeping && m->key_len == 8 && memcmp(m->key, "settings", 8) == 0 &&
            m->len + FOS_SCENE_META_MEMBER_MAX / 4 < FOS_SCENE_META_MAX) {
            /* The settings' own members, each kept or passed over by itself:
             * the mark is theirs from here, and the member of the scene that
             * holds them stays. */
            put(m, '{');
            m->kept[1] = true;
            m->kept[2] = false;
            m->level = 2;
            m->keeping = false;
            m->phase = PH_KEY;
            return;
        }
        drop(m);
        m->phase = PH_SKIP;
        return;
    case ']':
        m->failed = true;
        return;
    default:
        if (m->phase != PH_VALUE && m->phase != PH_LITERAL) {
            m->failed = true;
            return;
        }
        keep(m, c);
        m->phase = PH_LITERAL;
        return;
    }
}

void fos_scene_meta_feed(fos_scene_meta_t *meta, const char *bytes, size_t len)
{
    for (size_t i = 0; i < len; i++) feed(meta, bytes[i]);
}

const char *fos_scene_meta_text(fos_scene_meta_t *meta)
{
    return meta->whole && !meta->failed ? meta->text : NULL;
}

int fos_scene_meta_depth(const fos_scene_meta_t *meta)
{
    return meta->max_depth;
}
