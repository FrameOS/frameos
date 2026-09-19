// The log ring: retention, the dump format the browser parses, and upload
// batching that survives overflow and never emits broken JSON.
#include <stdlib.h>

#include "pk_json.h"
#include "pk_log.h"
#include "pk_test.h"

static uint32_t s_now = 0;
static int s_console_lines = 0;

static uint32_t fake_clock(void)
{
    return s_now;
}

static void fake_console(const char *line)
{
    (void)line;
    s_console_lines++;
}

typedef struct {
    char data[64 * 1024];
    size_t len;
} dump_t;

static void dump_write(void *arg, const char *data, size_t len)
{
    dump_t *dump = arg;
    memcpy(dump->data + dump->len, data, len);
    dump->len += len;
    dump->data[dump->len] = '\0';
}

static dump_t s_dump;

static void test_dump_format(void)
{
    pk_log_init(fake_clock, fake_console);
    s_now = 0;
    pk_logf("before the clock synced");
    s_now = 1789000000;
    pk_logf("wifi: connected, ip %s", "10.0.0.7");
    pk_logf("two\nlines"); // one entry per line keeps the dump parseable
    pk_log_event("{\"event\":\"render:done\",\"source\":\"pico\"}");
    CHECK(s_console_lines == 4);

    s_dump.len = 0;
    pk_log_dump(dump_write, &s_dump);
    // "<epoch|-> line" — embeddedUsbLogsModel.ts usbLogsTail() matches /^(\d+|-) (.*)$/
    CHECK_STR(s_dump.data,
              "- before the clock synced\n"
              "1789000000 wifi: connected, ip 10.0.0.7\n"
              "1789000000 two lines\n"
              "1789000000 {\"event\":\"render:done\",\"source\":\"pico\"}\n");
}

static void test_batch(void)
{
    pk_log_init(fake_clock, NULL);
    char body[2048];
    uint32_t cursor = 0;
    CHECK(!pk_log_upload_pending());
    CHECK(pk_log_build_batch(body, sizeof(body), &cursor) == 0);

    pk_logf("a \"quoted\" message");
    pk_log_event("{\"event\":\"metrics\",\"source\":\"pico\",\"renders\":3}");
    CHECK(pk_log_upload_pending());
    size_t len = pk_log_build_batch(body, sizeof(body), &cursor);
    CHECK(len == strlen(body));
    CHECK(pk_json_valid(body, len));
    CHECK_STR(body,
              "{\"logs\":[{\"event\":\"log\",\"source\":\"pico\",\"message\":\"a \\\"quoted\\\" message\"},"
              "{\"event\":\"metrics\",\"source\":\"pico\",\"renders\":3}]}");

    // Not acknowledged (the POST failed): the same batch comes again.
    uint32_t again = 0;
    CHECK(pk_log_build_batch(body, sizeof(body), &again) == len && again == cursor);
    pk_log_mark_uploaded(cursor);
    CHECK(!pk_log_upload_pending());
    CHECK(pk_log_build_batch(body, sizeof(body), &cursor) == 0);

    // An event that is not one whole JSON object travels as a message instead
    // of poisoning the batch.
    pk_log_event("{\"event\":\"truncated");
    pk_log_event("not json at all");
    len = pk_log_build_batch(body, sizeof(body), &cursor);
    CHECK(len > 0 && pk_json_valid(body, len));
    CHECK(strstr(body, "\"message\":\"{\\\"event\\\":\\\"truncated\"") != NULL);
    pk_log_mark_uploaded(cursor);
}

static void test_small_buffer_splits(void)
{
    pk_log_init(fake_clock, NULL);
    for (int i = 0; i < 10; i++) pk_logf("entry number %d with some padding to take up room", i);
    char body[300];
    int batches = 0;
    int entries = 0;
    while (pk_log_upload_pending() && batches < 20) {
        uint32_t cursor = 0;
        size_t len = pk_log_build_batch(body, sizeof(body), &cursor);
        CHECK(len > 0 && len < sizeof(body));
        CHECK(pk_json_valid(body, len));
        for (const char *p = body; (p = strstr(p, "entry number")) != NULL; p++) entries++;
        pk_log_mark_uploaded(cursor);
        batches++;
    }
    CHECK(batches > 1);  // did not fit in one
    CHECK(entries == 10); // nothing lost, nothing sent twice
}

static void test_overflow_reports_dropped(void)
{
    pk_log_init(fake_clock, NULL);
    int total = PK_LOG_SLOTS + 25;
    for (int i = 0; i < total; i++) pk_logf("line %d", i);

    s_dump.len = 0;
    pk_log_dump(dump_write, &s_dump);
    CHECK(strstr(s_dump.data, " line 24\n") == NULL); // overwritten
    CHECK(strstr(s_dump.data, " line 25\n") != NULL); // oldest survivor

    char *body = malloc(64 * 1024);
    uint32_t cursor = 0;
    size_t len = pk_log_build_batch(body, 64 * 1024, &cursor);
    CHECK(pk_json_valid(body, len));
    CHECK(strstr(body, "{\"event\":\"log:dropped\",\"source\":\"pico\",\"count\":25}") != NULL);
    pk_log_mark_uploaded(cursor);
    // Reported once.
    pk_logf("after");
    len = pk_log_build_batch(body, 64 * 1024, &cursor);
    CHECK(strstr(body, "log:dropped") == NULL);
    free(body);
}

static void test_long_line_is_cut_not_overrun(void)
{
    pk_log_init(fake_clock, NULL);
    char big[PK_LOG_LINE_MAX * 2];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    pk_logf("%s", big);
    big[0] = '{';
    big[sizeof(big) - 2] = '}';
    pk_log_event(big); // too long to keep as JSON
    char body[8192];
    uint32_t cursor = 0;
    size_t len = pk_log_build_batch(body, sizeof(body), &cursor);
    CHECK(len > 0 && pk_json_valid(body, len));
}

int main(void)
{
    test_dump_format();
    test_batch();
    test_small_buffer_splits();
    test_overflow_reports_dropped();
    test_long_line_is_cut_not_overrun();
    return pk_test_result("test_pk_log");
}
