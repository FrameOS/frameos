// The device server's request parsing, access rule and form decoding.
#include "pk_config_keys.h"
#include "pk_httpd_parse.h"
#include "pk_test.h"

static pk_httpd_parse_t parse(const char *text, pk_httpd_request_t *request)
{
    return pk_httpd_parse(text, strlen(text), request);
}

static void test_parse(void)
{
    pk_httpd_request_t request;
    CHECK(parse("GET /status?k=abc HTTP/1.1\r\nHost: frame42.local\r\n\r\n", &request) == PK_HTTPD_READY);
    CHECK_STR(request.method, "GET");
    CHECK_STR(request.path, "/status"); // the query string is not part of the route
    CHECK(request.content_length == 0);

    // What the backend sends (frame_http.py _auth_headers): Bearer + JSON body.
    const char *post = "POST /event/setCurrentScene HTTP/1.1\r\nhost: x\r\nAUTHORIZATION:   Bearer k3y  \r\n"
                       "Content-Type: application/json\r\ncontent-length: 17\r\n\r\n{\"sceneId\":\"abc\"}";
    CHECK(parse(post, &request) == PK_HTTPD_READY);
    CHECK_STR(request.method, "POST");
    CHECK_STR(request.path, "/event/setCurrentScene");
    CHECK_STR(request.authorization, "Bearer k3y  "); // leading space trimmed; value kept as sent
    CHECK(request.content_length == 17);
    CHECK(strcmp(post + request.body_offset, "{\"sceneId\":\"abc\"}") == 0);

    // Arrives in pieces: incomplete until the last body byte is in.
    for (size_t len = 0; len < strlen(post); len++) {
        CHECK(pk_httpd_parse(post, len, &request) == PK_HTTPD_INCOMPLETE);
    }

    CHECK(parse("GARBAGE\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST);
    CHECK(parse("GET status HTTP/1.1\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST); // not origin-form
    CHECK(parse("GET  HTTP/1.1\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST);
    CHECK(parse("VERYLONGMETHOD / HTTP/1.1\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 12abc\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST);
    CHECK(parse("POST / HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n", &request) == PK_HTTPD_BAD_REQUEST);
    char long_path[PK_HTTPD_PATH_MAX + 64];
    memset(long_path, 'a', sizeof(long_path));
    memcpy(long_path, "GET /", 5);
    memcpy(long_path + sizeof(long_path) - 16, " HTTP/1.1\r\n\r\n", 14);
    CHECK(parse(long_path, &request) == PK_HTTPD_BAD_REQUEST);
    // Header lines with no colon, or an over-long Authorization, are survivable.
    CHECK(parse("GET / HTTP/1.1\r\nnonsense\r\n\r\n", &request) == PK_HTTPD_READY);
    char long_auth[PK_HTTPD_AUTH_MAX + 128];
    memset(long_auth, 'x', sizeof(long_auth));
    memcpy(long_auth, "GET / HTTP/1.1\r\nAuthorization: ", 31);
    memcpy(long_auth + sizeof(long_auth) - 5, "\r\n\r\n", 5);
    CHECK(parse(long_auth, &request) == PK_HTTPD_READY);
    CHECK_STR(request.authorization, ""); // dropped, not truncated into a different credential
}

static void test_access(void)
{
    pk_config_t config;
    pk_config_defaults(&config);
    pk_httpd_request_t request;
    memset(&request, 0, sizeof(request));

    // Unprovisioned: nothing opens the door (an empty key never matches).
    snprintf(request.authorization, sizeof(request.authorization), "Bearer ");
    CHECK(!pk_httpd_authorized(&request, &config));
    request.authorization[0] = '\0';
    CHECK(!pk_httpd_authorized(&request, &config));

    snprintf(config.api_key, sizeof(config.api_key), "k3y-from-backend");
    snprintf(request.authorization, sizeof(request.authorization), "Bearer k3y-from-backend");
    CHECK(pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Bearer k3y-from-backenD");
    CHECK(!pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Bearer k3y-from-backend-and-more");
    CHECK(!pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Bearer k3y");
    CHECK(!pk_httpd_authorized(&request, &config)); // a prefix is not the key
    snprintf(request.authorization, sizeof(request.authorization), "bearer k3y-from-backend");
    CHECK(!pk_httpd_authorized(&request, &config));

    // Basic: "admin:hunter2" → YWRtaW46aHVudGVyMg==, only while the login is enabled.
    snprintf(config.admin_user, sizeof(config.admin_user), "admin");
    snprintf(config.admin_pass, sizeof(config.admin_pass), "hunter2");
    snprintf(request.authorization, sizeof(request.authorization), "Basic YWRtaW46aHVudGVyMg==");
    CHECK(!pk_httpd_authorized(&request, &config));
    config.admin_auth = 1;
    CHECK(pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Basic YWRtaW46aHVudGVyMw=="); // hunter3
    CHECK(!pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Basic !!!not-base64!!!");
    CHECK(!pk_httpd_authorized(&request, &config));
    snprintf(request.authorization, sizeof(request.authorization), "Basic ");
    CHECK(!pk_httpd_authorized(&request, &config));
}

static void test_form(void)
{
    const char *body = "wifi_ssid=My+Home%20Net&wifi_pass=p%40ss%26word%3D1&backend=http%3A%2F%2F10.0.0.5%3A8989"
                       "&frame_id=42&api_key=&hardware=pimoroni_inky_frame_7_3_spectra";
    size_t len = strlen(body);
    char value[128];
    CHECK(pk_httpd_form_value(body, len, "wifi_ssid", value, sizeof(value)));
    CHECK_STR(value, "My Home Net");
    CHECK(pk_httpd_form_value(body, len, "wifi_pass", value, sizeof(value)));
    CHECK_STR(value, "p@ss&word=1");
    CHECK(pk_httpd_form_value(body, len, "backend", value, sizeof(value)));
    CHECK_STR(value, "http://10.0.0.5:8989");
    CHECK(pk_httpd_form_value(body, len, "api_key", value, sizeof(value)));
    CHECK_STR(value, ""); // present and empty: "keep the current value"
    CHECK(pk_httpd_form_value(body, len, "hardware", value, sizeof(value)));
    CHECK_STR(value, "pimoroni_inky_frame_7_3_spectra");
    CHECK(!pk_httpd_form_value(body, len, "missing", value, sizeof(value)));
    CHECK(!pk_httpd_form_value(body, len, "wifi", value, sizeof(value)));  // prefix of a key
    CHECK(!pk_httpd_form_value(body, len, "ssid", value, sizeof(value)));  // suffix of a key
    char tiny[4];
    CHECK(!pk_httpd_form_value(body, len, "backend", tiny, sizeof(tiny))); // does not fit
    // Broken escapes and embedded NULs are refused.
    CHECK(!pk_httpd_form_value("a=%4", 4, "a", value, sizeof(value)));
    CHECK(!pk_httpd_form_value("a=%zz", 5, "a", value, sizeof(value)));
    CHECK(!pk_httpd_form_value("a=x%00y", 7, "a", value, sizeof(value)));
}

static void test_escape_and_base64(void)
{
    char out[64];
    pk_html_escape("<script>\"x\" & 'y'</script>", out, sizeof(out));
    CHECK_STR(out, "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
    char small[8];
    pk_html_escape("ab<cd", small, sizeof(small)); // "ab&lt;" is 6, then 'c' fits, 'd' does not
    CHECK_STR(small, "ab&lt;c");
    pk_html_escape("abcde<", small, sizeof(small)); // the entity would be cut: dropped whole
    CHECK_STR(small, "abcde");

    unsigned char bytes[16];
    CHECK(pk_base64_decode("aGVsbG8=", 8, bytes, sizeof(bytes)) == 5 && memcmp(bytes, "hello", 5) == 0);
    CHECK(pk_base64_decode("aGVsbG8", 7, bytes, sizeof(bytes)) == 5); // unpadded
    CHECK(pk_base64_decode("", 0, bytes, sizeof(bytes)) == 0);
    CHECK(pk_base64_decode("a*b", 3, bytes, sizeof(bytes)) == -1);
    CHECK(pk_base64_decode("aGVsbG8gd29ybGQgdG9vIGxvbmc=", 28, bytes, 4) == -1); // no room
}

int main(void)
{
    test_parse();
    test_access();
    test_form();
    test_escape_and_base64();
    return pk_test_result("test_pk_httpd_parse");
}
