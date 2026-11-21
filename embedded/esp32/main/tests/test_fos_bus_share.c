/* Host test of components/frameos_display/include/fos_bus_share.h: the
 * panel's SPI bus shared with an SD card (the reTerminal E-series). The panel
 * holds the bus for a whole refresh, and lets it go only for a wait it sleeps
 * through with every chip select high, so a card read can happen during an
 * e-paper waveform but never while the panel is listening.
 *
 * The bus here is a model of DEV_Config_esp.c: acquire, release, chip select
 * writes and the delay that yields, as that file wires them. A card asks for
 * the bus at every tick; what must hold is that it gets it during a busy
 * wait, never while a chip select is low, never while the panel transacts,
 * and that the panel has it back before its next command.
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Icomponents/frameos_display/include \
 *      main/tests/test_fos_bus_share.c -o t && ./t
 *
 * Run by backend/app/tasks/tests/test_esp32_bus_share.py.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "fos_bus_share.h"

static int checks = 0;
static int failures = 0;

#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            failures++;                                                          \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);               \
        }                                                                        \
    } while (0)

/* --- the model ------------------------------------------------------------ */

typedef enum { OWNER_NONE, OWNER_PANEL, OWNER_CARD } owner_t;

static fos_bus_share_t s_share;
static owner_t s_owner = OWNER_NONE;
static int s_card_reads = 0;        /* card transactions that got the bus */
static int s_card_while_selected = 0; /* ... while a panel chip select was low */
static int s_panel_without_bus = 0; /* panel transactions without the bus */

static void bus_acquire(owner_t who)
{
    /* The real lock blocks; in the model the card only asks when it is free. */
    CHECK(s_owner == OWNER_NONE);
    s_owner = who;
}

static void bus_release(owner_t who)
{
    CHECK(s_owner == who);
    s_owner = OWNER_NONE;
}

/* The card's task: one read a tick, whenever the bus is free. */
static void card_tick(void)
{
    if (s_owner != OWNER_NONE) return;
    bus_acquire(OWNER_CARD);
    s_card_reads++;
    if (s_share.cs_low != 0) s_card_while_selected++;
    bus_release(OWNER_CARD);
}

/* DEV_Config_esp.c, as it wires the header. */
static void DEV_SPI_Acquire(void)
{
    if (!s_share.shared) return;
    bus_acquire(OWNER_PANEL);
    fos_bus_share_take(&s_share);
}

static void DEV_SPI_Release(void)
{
    if (!s_share.shared) return;
    fos_bus_share_give(&s_share);
    bus_release(OWNER_PANEL);
}

static void DEV_Digital_Write_CS(int line, int level) { fos_bus_share_select(&s_share, line, level == 0); }

static void DEV_Delay_ms(int ms)
{
    bool yield = fos_bus_share_may_yield(&s_share);
    if (yield) {
        s_share.yields++;
        bus_release(OWNER_PANEL);
    }
    for (int t = 0; t < ms; t += 10) card_tick();
    if (yield) bus_acquire(OWNER_PANEL);
}

static void panel_write(void)
{
    if (s_share.shared && s_owner != OWNER_PANEL) s_panel_without_bus++;
}

/* A vendor command: CS low, a byte, CS high. */
static void send_command(int line)
{
    DEV_Digital_Write_CS(line, 0);
    panel_write();
    DEV_Digital_Write_CS(line, 1);
}

/* A vendor busy loop: poll BUSY, sleep 10 ms, `polls` times. */
static void busy_wait(int polls)
{
    for (int i = 0; i < polls; i++) DEV_Delay_ms(10);
}

static void reset_model(bool shared)
{
    s_share = (fos_bus_share_t){0};
    s_share.shared = shared;
    s_owner = OWNER_NONE;
    s_card_reads = 0;
    s_card_while_selected = 0;
    s_panel_without_bus = 0;
}

/* --- the tests ------------------------------------------------------------ */

static void test_a_refresh_lets_the_card_in_during_its_waits(void)
{
    reset_model(true);
    /* A Spectra refresh: init, the picture, power on and wait, refresh and
     * wait (the 25 s waveform: 2,500 polls), power off and wait, sleep. */
    DEV_SPI_Acquire();
    send_command(FOS_BUS_CS_MAIN);
    send_command(FOS_BUS_CS_MAIN);
    busy_wait(5);
    send_command(FOS_BUS_CS_MAIN);
    busy_wait(2500);
    send_command(FOS_BUS_CS_MAIN);
    busy_wait(5);
    DEV_SPI_Release();
    CHECK(s_card_reads >= 2500); /* a read a tick through the waveform */
    CHECK(s_card_while_selected == 0);
    CHECK(s_panel_without_bus == 0);
    CHECK(s_share.yields == 2510);
    CHECK(s_owner == OWNER_NONE);
}

static void test_never_while_a_chip_select_is_low(void)
{
    reset_model(true);
    /* The IT8951 loads a picture with its CS low across waits for HRDY: the
     * bus stays the panel's through all of them. */
    DEV_SPI_Acquire();
    DEV_Digital_Write_CS(FOS_BUS_CS_MAIN, 0);
    for (int chunk = 0; chunk < 20; chunk++) {
        busy_wait(1);
        panel_write();
    }
    DEV_Digital_Write_CS(FOS_BUS_CS_MAIN, 1);
    CHECK(s_card_reads == 0);
    CHECK(s_share.yields == 0);
    CHECK(s_panel_without_bus == 0);
    /* Its waveform then runs with CS high: the card gets in. */
    busy_wait(100);
    CHECK(s_card_reads >= 100);
    DEV_SPI_Release();
    CHECK(s_card_while_selected == 0);
}

static void test_either_select_of_a_two_controller_panel_holds_it(void)
{
    reset_model(true);
    /* The 13.3" panels: a main and a second chip select. */
    DEV_SPI_Acquire();
    DEV_Digital_Write_CS(FOS_BUS_CS_M, 0);
    busy_wait(3);
    CHECK(s_card_reads == 0);
    DEV_Digital_Write_CS(FOS_BUS_CS_M, 1);
    DEV_Digital_Write_CS(FOS_BUS_CS_S, 0);
    busy_wait(3);
    CHECK(s_card_reads == 0);
    DEV_Digital_Write_CS(FOS_BUS_CS_S, 1);
    busy_wait(3);
    CHECK(s_card_reads == 3);
    DEV_SPI_Release();
    CHECK(s_card_while_selected == 0);
}

static void test_no_card_no_change(void)
{
    reset_model(false);
    /* A panel alone on its bus: no hold, no yield. */
    DEV_SPI_Acquire();
    busy_wait(50);
    DEV_SPI_Release();
    CHECK(s_share.yields == 0);
    CHECK(!fos_bus_share_may_yield(&s_share));
}

static void test_a_wait_outside_a_refresh_is_not_a_yield(void)
{
    reset_model(true);
    /* Not held (a reset pulse before any refresh, the card's own time). */
    busy_wait(10);
    CHECK(s_share.yields == 0);
    CHECK(s_card_reads == 10);
}

static void test_init_deselects_every_line(void)
{
    reset_model(true);
    /* DEV_Module_Exit drove the chip selects low; init configures them high
     * without DEV_Digital_Write. */
    fos_bus_share_select(&s_share, FOS_BUS_CS_MAIN, true);
    fos_bus_share_select(&s_share, FOS_BUS_CS_S, true);
    fos_bus_share_deselect_all(&s_share);
    fos_bus_share_take(&s_share);
    CHECK(fos_bus_share_may_yield(&s_share));
    fos_bus_share_select(&s_share, 40, true); /* not a line: ignored */
    CHECK(fos_bus_share_may_yield(&s_share));
}

int main(void)
{
    test_a_refresh_lets_the_card_in_during_its_waits();
    test_never_while_a_chip_select_is_low();
    test_either_select_of_a_two_controller_panel_holds_it();
    test_no_card_no_change();
    test_a_wait_outside_a_refresh_is_not_a_yield();
    test_init_deselects_every_line();
    printf("%d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
