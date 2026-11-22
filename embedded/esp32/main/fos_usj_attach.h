/*
 * When the console installs its USB-Serial/JTAG driver: only once a USB host
 * is seen on the chip's native port, never on a board whose USB pads are
 * spoken for (fos_usb_pads.c). The driver's rings are 10 KB of internal RAM
 * that malloc() can reach (8 KB in, 2 KB out); on every bench board the
 * console is a CH340/CH343 on UART0 and no host is ever on the native port,
 * so the rings held 10 KB for nothing (docs/esp32-memory.md, "Console").
 *
 * Pure (host-tested, tests/test_fos_usj_attach.c): fos_console.c feeds it
 * IDF's connection monitor (usb_serial_jtag_is_connected, which reads the
 * port's start-of-frame interrupt from a tick hook and needs no driver).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Polls in a row a host must be seen before the driver goes in: the monitor
 * reports "connected" until its first ticks have passed, and one stray SOF
 * is not a host. With FOS_USJ_ATTACH_POLL_MS between polls a host plugged in
 * after boot gets the console within about a second. */
#define FOS_USJ_ATTACH_POLLS 2
#define FOS_USJ_ATTACH_POLL_MS 400

typedef struct {
    bool installed;
    uint8_t seen; /* polls in a row with a host */
} fos_usj_attach_t;

/* One poll. True exactly once: when the driver should be installed now (the
 * caller installs it and the state remembers it; it is never taken out). */
bool fos_usj_attach_poll(fos_usj_attach_t *state, bool pads_claimed, bool host_connected);
