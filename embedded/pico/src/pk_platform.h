// The one loop everything shares.
//
// The firmware is single-threaded on lwIP's NO_SYS poll architecture: network
// callbacks (the HTTP client, the device's own HTTP server, DHCP/DNS in portal
// mode) only run inside cyw43_arch_poll(). So nothing may sleep blind — a
// 25-second panel refresh spent in sleep_ms() would leave the server deaf and
// the USB console dead for the browser's `usb_api status`. Every wait in the
// firmware goes through pk_wait_ms()/pk_poll() instead, which keep the
// network, the console and the LEDs turning.
#ifndef PK_PLATFORM_H
#define PK_PLATFORM_H

#include <stdbool.h>
#include <stdint.h>

// One turn of the background work. Safe to call from anywhere except from
// inside an lwIP callback; re-entrant calls (a console command that waits)
// skip the console so a command never runs inside another.
void pk_poll(void);
void pk_wait_ms(uint32_t ms);

uint32_t pk_uptime_seconds(void);
uint32_t pk_random32(void);
// Unix epoch seconds, 0 until SNTP (or the RTC) has supplied the time.
uint32_t pk_epoch_or_zero(void);
// Flushes the console, then resets through the watchdog.
void pk_reboot(void);

// True while USB (VBUS) powers the board; the power-cut sleep only works —
// and is only wanted by "deep sleep on battery" — when this is false.
// VBUS sense and RSSI live on the wireless chip, and asking it (an ioctl)
// can dispatch a received frame into lwIP — fatal from inside an lwIP
// callback such as GET /status. So both are sampled from the main loop by
// pk_platform_sample() and everybody else reads the cached value.
bool pk_usb_powered(void);
int pk_wifi_rssi_cached(void);
void pk_platform_sample(void);

// Starts the hardware watchdog (fed by pk_poll) and, on an Inky Frame, the
// RTC dead-man timer that turns a watchdog reset on battery into a wake.
void pk_platform_start_watchdog(void);

// "pico-w" / "pico-2w": the platform key the control planes use.
const char *pk_platform_name(void);
// Free heap bytes (newlib mallinfo against the linker's heap limit).
uint32_t pk_free_heap(void);

#endif // PK_PLATFORM_H
