/*
 * The pass-start power decision: does this pass deep sleep, and is the cell
 * critical? Pure arithmetic on purpose — no IDF, no ADC — so
 * main/tests/test_fos_power.c can argue with it on a laptop. fos_client.c
 * feeds it the pass's battery reading plus the state it keeps in RTC memory
 * across deep sleeps, and writes the updated state back.
 *
 * Why a decision needs state at all: the battery read is one 16-sample ADC
 * burst, and a single burst has been seen reporting 0 % on a cell that read
 * 3932 mV seventy seconds later (E1004, 2026-08-27). Before this module that
 * one reading did two things at once — it parked the frame in the six-hour
 * "critical" sleep, and, because a sub-2.5 V reading also means "no cell",
 * it switched deep sleep OFF for the pass, so the "protect the cell" branch
 * sat awake with the radio on for nine hours. Now:
 *
 *  - a cell that has been seen stays "present" through one implausible
 *    reading (two consecutive sub-threshold reads clear it);
 *  - "critical" needs two consecutive passes of critical readings;
 *  - a critical cell IS a battery, so deep_sleep_on_battery sleeps on it
 *    whatever the presence test said.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* A cell reading at least this many mV counts as "running on battery" for
 * deep_sleep_on_battery. It is the best power-source signal we have: no
 * supported board wires VBUS to a readable pin (the PhotoPainter's AXP2101
 * could tell, but nothing reads its status registers yet). A plugged-in,
 * charging frame passes this too — acceptable, deep sleeping while charging
 * costs nothing. */
#define FOS_POWER_PRESENT_MV 2500
/* Below this the cell is nearly empty (about 3 % on fos_battery.c's
 * discharge curve): skip the render + panel refresh and sleep long, so a low
 * battery cannot keep cycling the display down to a damaging voltage. */
#define FOS_POWER_CRITICAL_MV 3200
/* A reading this far below the last believed one, inside one pass interval,
 * is a sensor glitch until it repeats: a resting Li-ion cell does not lose
 * 0.6 V between two wakes. */
#define FOS_POWER_GLITCH_DROP_MV 600
/* Consecutive passes a doubtful reading has to repeat before it is believed:
 * for "no cell", for "critical", and for a large drop. */
#define FOS_POWER_CONFIRM_PASSES 2

/* What survives between passes (RTC memory on the device: zeroed on a
 * power-on reset, kept through deep sleep). All zero = never read a cell. */
typedef struct {
    int last_good_mv;         /* last believed reading, 0 = none yet */
    uint8_t low_streak;       /* consecutive passes reading below PRESENT */
    uint8_t critical_streak;  /* consecutive passes reading below CRITICAL */
    uint8_t drop_streak;      /* consecutive passes with an implausible drop */
} fos_power_state_t;

typedef struct {
    int mv;                       /* this pass's reading; 0 = no reading */
    bool deep_sleep;              /* config: always deep sleep */
    bool deep_sleep_on_battery;   /* config: deep sleep while a cell is present */
} fos_power_input_t;

typedef struct {
    int mv_used;        /* the millivolts the decision believed */
    bool on_battery;    /* a cell is present (deep_sleep_on_battery's test) */
    bool critical;      /* skip the render, sleep FOS_BATTERY_CRITICAL_SLEEP_SEC */
    bool deep_sleep;    /* this pass ends in esp_deep_sleep */
    bool suspect;       /* the reading was overridden or is awaiting confirmation */
} fos_power_decision_t;

/* Decide the pass from the reading and the carried state; `state` is
 * updated in place for the next pass. `in` may carry mv == 0 for a frame
 * without battery sensing: then on_battery and critical are false, and only
 * `deep_sleep` (the always-on flag) can sleep. */
void fos_power_decide(const fos_power_input_t *in, fos_power_state_t *state,
                      fos_power_decision_t *out);
