// Console lines that must wait for the end of a render pass, and the queue
// that holds them.
#include "pk_console_queue.h"
#include "pk_test.h"

int main(void)
{
    // Read-only and harmless mid-refresh: answered at once.
    CHECK(!pk_console_waits_for_panel("status"));
    CHECK(!pk_console_waits_for_panel("logs"));
    CHECK(!pk_console_waits_for_panel("render"));
    CHECK(!pk_console_waits_for_panel("buttons"));
    CHECK(!pk_console_waits_for_panel("wifi-scan")); // refuses by itself while busy
    CHECK(!pk_console_waits_for_panel("usb_api status"));
    CHECK(!pk_console_waits_for_panel("usb_api logs"));
    CHECK(!pk_console_waits_for_panel("usb_api render"));
    CHECK(!pk_console_waits_for_panel("usb_api wifi-scan"));
    CHECK(!pk_console_waits_for_panel("usb_api"));
    CHECK(!pk_console_waits_for_panel(""));
    CHECK(!pk_console_waits_for_panel("   "));
    CHECK(!pk_console_waits_for_panel("set\"")); // unterminated quote: handle_line reports it
    CHECK(!pk_console_waits_for_panel(NULL));
    CHECK(!pk_console_waits_for_panel("settings"));

    // Pins, panel, flash or power: after the pass.
    CHECK(pk_console_waits_for_panel("set panel EPD_7in3e"));
    CHECK(pk_console_waits_for_panel("  set   interval 900"));
    CHECK(pk_console_waits_for_panel("wifi \"My Net\" pass"));
    CHECK(pk_console_waits_for_panel("restart"));
    CHECK(pk_console_waits_for_panel("factory-reset"));
    CHECK(pk_console_waits_for_panel("bootsel"));
    CHECK(pk_console_waits_for_panel("usb_api set wifi_ssid \"My Home  Network\""));
    CHECK(pk_console_waits_for_panel("usb_api wifi net pass"));
    CHECK(pk_console_waits_for_panel("usb_api restart"));
    CHECK(pk_console_waits_for_panel("usb_api factory-reset"));
    CHECK(pk_console_waits_for_panel("usb_api bootsel"));

    CHECK(pk_console_is_usb_api("usb_api status"));
    CHECK(pk_console_is_usb_api("  usb_api"));
    CHECK(!pk_console_is_usb_api("usb_apiX status"));
    CHECK(!pk_console_is_usb_api("set x"));
    CHECK(!pk_console_is_usb_api(NULL));

    // FIFO, bounded, never truncates a line.
    pk_console_queue_t queue;
    pk_console_queue_init(&queue);
    char out[PK_CONSOLE_QUEUE_LINE_MAX];
    CHECK(!pk_console_queue_pop(&queue, out, sizeof(out)));
    CHECK(pk_console_queue_push(&queue, "set a 1"));
    CHECK(pk_console_queue_push(&queue, "set b 2"));
    CHECK(pk_console_queue_pop(&queue, out, sizeof(out)));
    CHECK_STR(out, "set a 1");
    CHECK(pk_console_queue_push(&queue, "set c 3"));
    CHECK(pk_console_queue_push(&queue, "set d 4"));
    CHECK(pk_console_queue_push(&queue, "restart")); // wraps around
    CHECK(!pk_console_queue_push(&queue, "bootsel")); // full
    CHECK(queue.count == PK_CONSOLE_QUEUE_SLOTS);
    const char *expected[] = {"set b 2", "set c 3", "set d 4", "restart"};
    for (int i = 0; i < 4; i++) {
        CHECK(pk_console_queue_pop(&queue, out, sizeof(out)));
        CHECK_STR(out, expected[i]);
    }
    CHECK(!pk_console_queue_pop(&queue, out, sizeof(out)));

    static char longest[PK_CONSOLE_QUEUE_LINE_MAX + 1];
    memset(longest, 'x', sizeof(longest) - 1);
    longest[sizeof(longest) - 1] = '\0';
    CHECK(!pk_console_queue_push(&queue, longest));
    longest[PK_CONSOLE_QUEUE_LINE_MAX - 1] = '\0';
    CHECK(pk_console_queue_push(&queue, longest));
    CHECK(pk_console_queue_pop(&queue, out, sizeof(out)));
    CHECK(strlen(out) == PK_CONSOLE_QUEUE_LINE_MAX - 1);

    return pk_test_result("test_pk_console_queue");
}
