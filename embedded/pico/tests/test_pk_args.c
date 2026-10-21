// Console tokenizer: must agree with how the browser quotes `usb_api set`
// values (quoteEmbeddedUsbConsoleValue: wrap in "…", escape \ and ").
#include "pk_args.h"
#include "pk_test.h"

static int split(const char *text, char **argv, int max, char *storage, size_t cap)
{
    snprintf(storage, cap, "%s", text);
    return pk_args_split(storage, argv, max);
}

int main(void)
{
    char line[256];
    char *argv[8];

    CHECK(split("status", argv, 8, line, sizeof(line)) == 1);
    CHECK_STR(argv[0], "status");

    CHECK(split("  set   interval\t900  ", argv, 8, line, sizeof(line)) == 3);
    CHECK_STR(argv[0], "set");
    CHECK_STR(argv[1], "interval");
    CHECK_STR(argv[2], "900");

    // An SSID with spaces — the thing the old strtok console could not take.
    CHECK(split("usb_api set wifi_ssid \"My Home  Network\"", argv, 8, line, sizeof(line)) == 4);
    CHECK_STR(argv[3], "My Home  Network");

    // A password with a quote and a backslash, as the browser sends it.
    CHECK(split("usb_api set wifi_pass \"a\\\"b\\\\c d\"", argv, 8, line, sizeof(line)) == 4);
    CHECK_STR(argv[3], "a\"b\\c d");

    // Backslash-space outside quotes; adjacent quoted pieces join.
    CHECK(split("wifi My\\ Net pa\"ss wo\"rd", argv, 8, line, sizeof(line)) == 3);
    CHECK_STR(argv[1], "My Net");
    CHECK_STR(argv[2], "pass word");

    // An empty quoted value is an argument.
    CHECK(split("set name \"\"", argv, 8, line, sizeof(line)) == 3);
    CHECK_STR(argv[2], "");

    CHECK(split("", argv, 8, line, sizeof(line)) == 0);
    CHECK(split("   \t ", argv, 8, line, sizeof(line)) == 0);
    CHECK(split("set name \"unterminated", argv, 8, line, sizeof(line)) == -1);

    // More arguments than slots: the rest is dropped, nothing is overrun.
    CHECK(split("a b c d e f", argv, 3, line, sizeof(line)) == 3);
    CHECK_STR(argv[2], "c");

    // A trailing backslash is kept literally rather than reading past the end.
    CHECK(split("set key value\\", argv, 8, line, sizeof(line)) == 3);
    CHECK_STR(argv[2], "value\\");

    return pk_test_result("test_pk_args");
}
