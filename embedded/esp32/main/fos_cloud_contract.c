/*
 * Walker for the generated contract tables (fos_cloud_contract_gen.h). See
 * fos_cloud_contract.h. Kept free of IDF headers on purpose — it must build
 * with a laptop compiler for the fixture test.
 */
#include "fos_cloud_contract.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "fos_cloud_contract_gen.h"

/* ------------------------------------------------------------ formats */

static bool is_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static bool is_alnum(char c) { return is_alpha(c) || (c >= '0' && c <= '9'); }

/* ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ */
static bool is_iana_zone(const char *s)
{
    size_t len = strlen(s);
    if (len == 0 || !is_alpha(s[0])) return false;
    size_t segment = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c == '/') {
            if (i == 0 || segment == 0 || i + 1 == len) return false;
            segment = 0;
        } else if (is_alnum(c) || c == '_' || c == '+' || c == '-') {
            segment++;
        } else {
            return false;
        }
    }
    return true;
}

static bool is_hex_digit(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool is_html_hex_color(const char *s)
{
    if (strlen(s) != 7 || s[0] != '#') return false;
    for (int i = 1; i < 7; i++) {
        if (!is_hex_digit(s[i])) return false;
    }
    return true;
}

/* 1..32 characters after trimming whitespace, no ':' and no newline. */
static bool is_gpio_label(const char *s)
{
    if (strchr(s, ':') || strchr(s, '\n')) return false;
    size_t start = 0, end = strlen(s);
    while (start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r')) start++;
    while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t' || s[end - 1] == '\r')) end--;
    size_t len = end - start;
    return len >= 1 && len <= 32;
}

static bool matches_format(uint8_t format, const char *s)
{
    switch (format) {
        case FOS_FMT_IANA_ZONE: return is_iana_zone(s);
        case FOS_FMT_HTML_HEX_COLOR: return is_html_hex_color(s);
        case FOS_FMT_GPIO_LABEL: return is_gpio_label(s);
        default: return true;
    }
}

/* ------------------------------------------------------------ the walker */

static bool validate_rule(int16_t index, const cJSON *value);

static bool is_integer_number(const cJSON *value)
{
    return cJSON_IsNumber(value) && value->valuedouble == floor(value->valuedouble) &&
           fabs(value->valuedouble) < 9007199254740992.0;
}

static bool validate_rule(int16_t index, const cJSON *value)
{
    if (index < 0 || value == NULL) return false;
    const fos_rule_t *rule = &k_fos_rules[index];
    switch (rule->kind) {
        case FOS_RULE_BOOL:
            return cJSON_IsBool(value);
        case FOS_RULE_NULL:
            return cJSON_IsNull(value);
        case FOS_RULE_INT: {
            if (!is_integer_number(value)) return false;
            double n = value->valuedouble;
            if (rule->has_min && n < (double)rule->min) return false;
            if (rule->has_max && n > (double)rule->max) return false;
            if (rule->enum_count > 0) {
                for (int i = 0; i < rule->enum_count; i++) {
                    if ((double)k_fos_rule_int_enums[rule->enum_start + i] == n) return true;
                }
                return false;
            }
            return true;
        }
        case FOS_RULE_NUMBER: {
            if (!cJSON_IsNumber(value)) return false;
            double n = value->valuedouble;
            if (rule->has_min && n < (double)rule->min) return false;
            if (rule->has_max && n > (double)rule->max) return false;
            return true;
        }
        case FOS_RULE_STRING: {
            if (!cJSON_IsString(value) || value->valuestring == NULL) return false;
            const char *s = value->valuestring;
            size_t len = strlen(s);
            if (rule->min_len >= 0 && len < (size_t)rule->min_len) return false;
            if (rule->max_len >= 0 && len > (size_t)rule->max_len) return false;
            if (rule->enum_count > 0) {
                bool found = false;
                for (int i = 0; i < rule->enum_count && !found; i++) {
                    found = strcmp(k_fos_rule_str_enums[rule->enum_start + i], s) == 0;
                }
                if (!found) return false;
            }
            return matches_format(rule->format, s);
        }
        case FOS_RULE_OBJECT: {
            if (!cJSON_IsObject(value)) return false;
            int count = 0;
            const cJSON *child = NULL;
            cJSON_ArrayForEach(child, value) {
                count++;
                const char *name = child->string ? child->string : "";
                bool known = false;
                for (int i = 0; i < rule->keys_count; i++) {
                    const fos_rule_key_t *key = &k_fos_rule_keys[rule->keys_start + i];
                    if (strcmp(key->name, name) == 0) {
                        known = true;
                        if (!validate_rule(key->rule, child)) return false;
                        break;
                    }
                }
                if (!known && !rule->open) return false;
            }
            if (count < rule->min_keys) return false;
            for (int i = 0; i < rule->keys_count; i++) {
                const fos_rule_key_t *key = &k_fos_rule_keys[rule->keys_start + i];
                if (key->required && cJSON_GetObjectItem(value, key->name) == NULL) return false;
            }
            return true;
        }
        case FOS_RULE_ARRAY: {
            if (!cJSON_IsArray(value)) return false;
            if (rule->max_items >= 0 && cJSON_GetArraySize(value) > rule->max_items) return false;
            int16_t items = k_fos_rule_children[rule->children_start];
            const cJSON *item = NULL;
            cJSON_ArrayForEach(item, value) {
                if (!validate_rule(items, item)) return false;
            }
            return true;
        }
        case FOS_RULE_MAP: {
            if (!cJSON_IsObject(value)) return false;
            if (rule->max_items >= 0 && cJSON_GetArraySize(value) > rule->max_items) return false;
            int16_t values = k_fos_rule_children[rule->children_start];
            const cJSON *entry = NULL;
            cJSON_ArrayForEach(entry, value) {
                size_t key_len = entry->string ? strlen(entry->string) : 0;
                if (rule->key_min_len >= 0 && key_len < (size_t)rule->key_min_len) return false;
                if (rule->key_max_len >= 0 && key_len > (size_t)rule->key_max_len) return false;
                if (!validate_rule(values, entry)) return false;
            }
            return true;
        }
        case FOS_RULE_ANY_OF:
            for (int i = 0; i < rule->children_count; i++) {
                if (validate_rule(k_fos_rule_children[rule->children_start + i], value)) return true;
            }
            return false;
        default:
            return false;
    }
}

/* The contract's `extraChecks`: what the rule language cannot say, done by
 * hand in every validator. */
static bool extra_checks(const char *key, const cJSON *value)
{
    if (strcmp(key, "gpio_buttons") == 0) {
        const cJSON *a = NULL;
        cJSON_ArrayForEach(a, value) {
            const cJSON *pin_a = cJSON_GetObjectItem(a, "pin");
            for (const cJSON *b = a->next; b != NULL; b = b->next) {
                const cJSON *pin_b = cJSON_GetObjectItem(b, "pin");
                if (cJSON_IsNumber(pin_a) && cJSON_IsNumber(pin_b) &&
                    pin_a->valuedouble == pin_b->valuedouble) {
                    return false;
                }
            }
        }
    }
    /* palette's colorNames/colors count check is a Linux-only key; the
     * firmware never carries palette. */
    return true;
}

static const fos_contract_setting_t *find_setting(const char *key)
{
    for (int i = 0; i < FOS_CONTRACT_SETTINGS_COUNT; i++) {
        if (strcmp(k_fos_contract_settings[i].key, key) == 0) return &k_fos_contract_settings[i];
    }
    return NULL;
}

bool fos_cloud_contract_setting_allowed(const char *key)
{
    return key != NULL && find_setting(key) != NULL;
}

bool fos_cloud_contract_setting_restarts(const char *key)
{
    const fos_contract_setting_t *setting = key ? find_setting(key) : NULL;
    return setting != NULL && setting->restart;
}

const char *fos_cloud_contract_check_settings(const cJSON *settings)
{
    if (!cJSON_IsObject(settings) || cJSON_GetArraySize(settings) == 0) return "invalid_settings";
    const cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, settings) {
        if (find_setting(entry->string ? entry->string : "") == NULL) return "setting_not_allowed";
    }
    cJSON_ArrayForEach(entry, settings) {
        const fos_contract_setting_t *setting = find_setting(entry->string);
        if (!validate_rule(setting->rule, entry) || !extra_checks(setting->key, entry)) {
            return "invalid_settings";
        }
        if (setting->companion && cJSON_GetObjectItem(settings, setting->companion) == NULL) {
            return "invalid_settings";
        }
    }
    return NULL;
}

bool fos_cloud_contract_verb(const char *verb, const char **scope, bool *content)
{
    if (scope) *scope = NULL;
    if (content) *content = false;
    if (verb == NULL) return false;
    for (int i = 0; i < FOS_CONTRACT_VERBS_COUNT; i++) {
        if (strcmp(k_fos_contract_verbs[i].verb, verb) == 0) {
            if (scope) *scope = k_fos_contract_verbs[i].scope;
            if (content) *content = k_fos_contract_verbs[i].content;
            return true;
        }
    }
    return false;
}
