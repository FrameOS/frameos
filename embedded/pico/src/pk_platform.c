#include "pk_platform.h"

#include <malloc.h>
#include <stdio.h>

#include "hardware/watchdog.h"
#include "pico/cyw43_arch.h"
#include "pico/rand.h"
#include "pico/stdlib.h"

#include "pk_config.h"
#include "pk_console.h"
#include "pk_leds.h"
#include "pk_rtc.h"
#include "pk_time.h"
#include "pk_wifi.h"

// The longest stretch without a pk_poll() is a flash erase or the 2 s the
// power-cut waits for the rail to drop; 8 s is the most an RP2040 can count.
#define WATCHDOG_MS 8000
#define SAMPLE_EVERY_MS 2000
// Re-armed every minute while alive; if it ever runs out, the board was reset
// on battery (= powered off) and this is what brings it back.
#define DEADMAN_SECONDS 240
#define DEADMAN_REARM_MS 60000

static int s_poll_depth = 0;
static bool s_in_network_poll = false;
static bool s_watchdog = false;
static bool s_usb_powered = true;
static int s_rssi = 0;
static absolute_time_t s_next_sample;
static absolute_time_t s_next_deadman;

void pk_poll(void)
{
    // lwIP callbacks run inside cyw43_arch_poll(); one that ends up waiting
    // (a sink that touches the panel) must not re-enter the stack.
    if (s_in_network_poll) return;
    if (s_watchdog) watchdog_update();
    s_poll_depth++;
    if (pk_wifi_ready()) {
        s_in_network_poll = true;
        cyw43_arch_poll();
        s_in_network_poll = false;
    }
    pk_leds_tick();
    // A console command may itself wait (a Wi-Fi scan, a reboot countdown);
    // only the outermost turn reads the console, so commands never nest.
    if (s_poll_depth == 1) {
        pk_console_poll();
        // Here rather than only in the main loop: a render pass can outlast
        // the dead-man timer, and this is never inside an lwIP callback.
        pk_platform_sample();
    }
    s_poll_depth--;
}

void pk_wait_ms(uint32_t ms)
{
    absolute_time_t deadline = make_timeout_time_ms(ms);
    do {
        pk_poll();
        sleep_ms(1);
    } while (absolute_time_diff_us(get_absolute_time(), deadline) > 0);
}

uint32_t pk_uptime_seconds(void)
{
    return to_ms_since_boot(get_absolute_time()) / 1000u;
}

uint32_t pk_random32(void)
{
    return get_rand_32();
}

uint32_t pk_epoch_or_zero(void)
{
    return pk_time_synced() ? (uint32_t)pk_time_now(NULL) : 0;
}

void pk_platform_start_watchdog(void)
{
    s_next_sample = get_absolute_time();
    s_next_deadman = get_absolute_time();
    watchdog_enable(WATCHDOG_MS, true);
    s_watchdog = true;
}

void pk_platform_sample(void)
{
    if (absolute_time_diff_us(get_absolute_time(), s_next_sample) <= 0) {
        s_next_sample = make_timeout_time_ms(SAMPLE_EVERY_MS);
        if (pk_wifi_ready()) {
            // VBUS sense hangs off the wireless chip on every Pico W / 2 W.
            s_usb_powered = cyw43_arch_gpio_get(CYW43_WL_GPIO_VBUS_PIN);
            s_rssi = pk_wifi_rssi();
        }
    }
    if (s_watchdog && pk_config()->pins.hold_vsys >= 0 &&
        absolute_time_diff_us(get_absolute_time(), s_next_deadman) <= 0) {
        s_next_deadman = make_timeout_time_ms(DEADMAN_REARM_MS);
        pk_rtc_arm_wake(DEADMAN_SECONDS);
    }
}

void pk_reboot(void)
{
    // A reset floats HOLD_VSYS_EN: on battery the board powers off rather
    // than restarting, so the RTC is asked to switch it back on.
    if (pk_config()->pins.hold_vsys >= 0) pk_rtc_arm_wake(3);
    stdio_flush();
    sleep_ms(100);
    // Watchdog reboot re-runs the whole boot sequence; works on both RP2040
    // and RP2350, unlike a raw AIRCR write.
    watchdog_reboot(0, 0, 0);
    for (;;) {
        tight_loop_contents();
    }
}

bool pk_usb_powered(void)
{
    return s_usb_powered;
}

int pk_wifi_rssi_cached(void)
{
    return s_rssi;
}

const char *pk_platform_name(void)
{
#if PICO_RP2350
    return "pico-2w";
#else
    return "pico-w";
#endif
}

uint32_t pk_free_heap(void)
{
    extern char __StackLimit, __bss_end__;
    struct mallinfo info = mallinfo();
    // The 16 KB stack's lower half lies in the top of the heap region
    // (pico-sdk's default layout): not memory malloc should be counted on.
    uint32_t total = (uint32_t)(&__StackLimit - &__bss_end__);
    total = total > 8192u ? total - 8192u : 0;
    return total > (uint32_t)info.uordblks ? total - (uint32_t)info.uordblks : 0;
}
