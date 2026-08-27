/*
 * ESP32 GPIO buttons. Buttons are active-low inputs with internal pull-ups and
 * emit the same "button" events as the Linux gpioButton driver.
 *
 * Deep sleep: every registered button that sits on a wake-capable pad (an
 * RTC IO on the S3, GPIO0-5 on the C3) is armed as a wake source right
 * before esp_deep_sleep, so a press brings the frame back early — the scene
 * gets the press as a normal "button" event on the first pass and the panel
 * refreshes, instead of the frame waiting out its timer. The pure pin
 * arithmetic is in fos_wake.h; this module owns the esp_sleep calls.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t fos_buttons_start(void);
void fos_buttons_process_events(void);

/* Call once, early in boot: if this boot is a deep-sleep wake caused by a
 * registered button, remember which so fos_buttons_start can replay the
 * press to the scene (by then the key has long been released — the task's
 * own edge detector never sees it). */
void fos_buttons_wake_boot(void);
/* True when this boot was a button wake; fills the pin and label (either
 * may be NULL). Stays true for the whole boot — the render loop reads it once
 * to turn its first pass into a render instead of a command check-in. */
bool fos_buttons_woke_by_button(int *pin, char *label, size_t label_len);
/* Arm the registered buttons as deep-sleep wake sources. `*armed_mask`
 * (may be NULL) receives the GPIO bit mask actually armed — 0 when no
 * button can wake this chip, or every key is currently held. Call right
 * before esp_deep_sleep; the timer wake is armed separately by
 * esp_deep_sleep itself and both sources stay active. */
esp_err_t fos_buttons_arm_wake(uint64_t *armed_mask);
/* Can a press on this GPIO wake the chip from deep sleep? (console `buttons`) */
bool fos_buttons_pin_can_wake(int pin);
