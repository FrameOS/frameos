// The JSON walker against the document shapes the firmware actually reads,
// plus the malformed input a flaky network can hand it.
#include "pk_json.h"
#include "pk_test.h"

static const char SETTINGS[] =
    "{\"openAI\":{\"apiKey\":\"sk-{not}[a]\\\"brace\"},"
    " \"frame\": {\"interval\": 900.0, \"name\": \"Hallway \\u00e9\\ud83d\\ude00\","
    "  \"deepSleep\": true, \"rotate\": 90,"
    "  \"adminAuth\": {\"enabled\": false, \"user\": \"admin\", \"pass\": \"p\\\\w\"},"
    "  \"tls\": {\"cert\": \"-----BEGIN\\nCERT\", \"port\": 8443}, \"nothing\": null},"
    " \"schedule\": {\"events\": [{\"hour\": 7, \"payload\": {\"a\": [1, [2, {\"b\": 3}]]}}]}}";

static bool find(const char *path, pk_json_slice_t *out)
{
    return pk_json_find(SETTINGS, sizeof(SETTINGS) - 1, path, out);
}

static void test_find(void)
{
    pk_json_slice_t value;
    long number = 0;
    bool flag = false;
    char text[64];

    CHECK(find("frame.interval", &value) && pk_json_as_long(value, &number) && number == 900);
    CHECK(find("frame.rotate", &value) && pk_json_as_long(value, &number) && number == 90);
    CHECK(find("frame.deepSleep", &value) && pk_json_as_bool(value, &flag) && flag);
    CHECK(find("frame.adminAuth.enabled", &value) && pk_json_as_bool(value, &flag) && !flag);
    CHECK(find("frame.adminAuth.pass", &value) && pk_json_as_string(value, text, sizeof(text)));
    CHECK_STR(text, "p\\w");
    CHECK(find("frame.nothing", &value) && pk_json_is_null(value));
    // Braces, brackets and an escaped quote inside a string do not derail
    // the walk to a later key.
    CHECK(find("openAI.apiKey", &value) && pk_json_as_string(value, text, sizeof(text)));
    CHECK_STR(text, "sk-{not}[a]\"brace");
    // \u escapes, including a surrogate pair, come out as UTF-8.
    CHECK(find("frame.name", &value) && pk_json_as_string(value, text, sizeof(text)));
    CHECK_STR(text, "Hallway \xC3\xA9\xF0\x9F\x98\x80");
    CHECK(find("frame.tls.cert", &value) && pk_json_as_string(value, text, sizeof(text)));
    CHECK_STR(text, "-----BEGIN\nCERT");
    // Nested containers are skipped whole.
    CHECK(find("schedule", &value) && value.start[0] == '{');

    CHECK(!find("frame.missing", &value));
    CHECK(!find("frame.interval.deeper", &value)); // a number is not an object
    CHECK(!find("missing.interval", &value));
    CHECK(!find("", &value) || value.start[0] == '{'); // empty path = whole document
    CHECK(!find("frame..interval", &value));
    // A key match must be the whole key.
    CHECK(!find("frame.inter", &value));
    CHECK(!find("frame.intervals", &value));
}

static void test_types(void)
{
    pk_json_slice_t value;
    long number;
    bool flag;
    char text[8];
    CHECK(find("frame.name", &value));
    CHECK(!pk_json_as_long(value, &number));
    CHECK(!pk_json_as_bool(value, &flag));
    CHECK(!pk_json_as_string(value, text, sizeof(text))); // does not fit in 8
    CHECK(find("frame.interval", &value) && !pk_json_as_string(value, text, sizeof(text)));
    const char negative[] = "{\"n\":-42,\"e\":1e3}";
    CHECK(pk_json_find(negative, sizeof(negative) - 1, "n", &value) && pk_json_as_long(value, &number) &&
          number == -42);
    CHECK(pk_json_find(negative, sizeof(negative) - 1, "e", &value) && pk_json_as_long(value, &number) &&
          number == 1);
}

static void test_malformed(void)
{
    static const char *const bad[] = {
        "", "{", "{\"a\"", "{\"a\":", "{\"a\":1", "{\"a\":1,}", "{\"a\" 1}", "{a:1}", "[1,]", "[1 2]",
        "{\"a\":tru}", "{\"a\":\"unterminated}", "{\"a\":\"bad\\", "{\"a\":01x}", "{\"a\":-}", "{\"a\":1.}",
        "{\"a\":1e}", "\"ctrl\x01\"", "{} trailing", "nul",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        if (pk_json_valid(bad[i], strlen(bad[i]))) {
            fprintf(stderr, "accepted malformed: %s\n", bad[i]);
            CHECK(false);
        } else {
            CHECK(true);
        }
    }
    static const char *const good[] = {
        "{}", "[]", " { \"a\" : [ ] } ", "null", "true", "-0.5e+10", "\"\\u0041\"", "[[[[]]]]",
    };
    for (size_t i = 0; i < sizeof(good) / sizeof(good[0]); i++) {
        CHECK(pk_json_valid(good[i], strlen(good[i])));
    }

    // Truncated mid-document (a dropped connection): every prefix is either
    // rejected or, for keys fully seen, answered — never read past the end.
    pk_json_slice_t value;
    for (size_t len = 0; len < sizeof(SETTINGS) - 1; len++) {
        (void)pk_json_find(SETTINGS, len, "schedule.events", &value);
        CHECK(!pk_json_valid(SETTINGS, len));
    }

    // Nesting past the depth limit is refused, not recursed into.
    char deep[2 * (PK_JSON_MAX_DEPTH + 4) + 1];
    size_t depth = PK_JSON_MAX_DEPTH + 4;
    memset(deep, '[', depth);
    memset(deep + depth, ']', depth);
    deep[2 * depth] = '\0';
    CHECK(!pk_json_valid(deep, 2 * depth));

    // Bad escapes and lone surrogates fail string extraction.
    char text[32];
    const char *lone = "{\"s\":\"\\ud83d\"}";
    CHECK(pk_json_find(lone, strlen(lone), "s", &value) && !pk_json_as_string(value, text, sizeof(text)));
    const char *nul = "{\"s\":\"a\\u0000b\"}";
    CHECK(pk_json_find(nul, strlen(nul), "s", &value) && !pk_json_as_string(value, text, sizeof(text)));
}

static void test_escape(void)
{
    char out[64];
    CHECK(pk_json_escape("say \"hi\"\\\n\t\x01", out, sizeof(out)) == strlen("say \\\"hi\\\"\\\\\\n\\t\\u0001"));
    CHECK_STR(out, "say \\\"hi\\\"\\\\\\n\\t\\u0001");
    CHECK(pk_json_escape(NULL, out, sizeof(out)) == 0);

    // A cut never lands inside an escape or a UTF-8 sequence.
    char small[6];
    pk_json_escape("abc\"def", small, sizeof(small)); // "abc" + \" = 5 bytes fits exactly
    CHECK_STR(small, "abc\\\"");
    pk_json_escape("abcd\"", small, sizeof(small)); // the escape would need 6
    CHECK_STR(small, "abcd");
    pk_json_escape("abc\xC3\xA9\xC3\xA9", small, sizeof(small)); // second é would be cut in half
    CHECK_STR(small, "abc\xC3\xA9");

    // Round trip through the reader.
    const char *original = "say \"hi\"\\\n\t\x01";
    CHECK(pk_json_escape(original, out, sizeof(out)) == pk_json_escaped_len(original));
    char document[96];
    snprintf(document, sizeof(document), "{\"m\":\"%s\"}", out);
    pk_json_slice_t value;
    char back[32];
    CHECK(pk_json_find(document, strlen(document), "m", &value) && pk_json_as_string(value, back, sizeof(back)));
    CHECK_STR(back, "say \"hi\"\\\n\t\x01");
}

int main(void)
{
    test_find();
    test_types();
    test_malformed();
    test_escape();
    return pk_test_result("test_pk_json");
}
