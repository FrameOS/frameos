// The Inky Frame's front LEDs: ACTIVITY (GP6) blinks while the firmware is
// working (fetching, refreshing), CONNECTION (GP7) is lit while Wi-Fi is up
// and blinks in setup-hotspot mode, and the five button LEDs (GP11-15)
// acknowledge a press. Only driven on an Inky Frame preset — on a bare Pico
// those GPIOs belong to whatever the user wired to them.
#ifndef PK_LEDS_H
#define PK_LEDS_H

#include <stdbool.h>

typedef enum {
    PK_LED_OFF = 0,
    PK_LED_ON,
    PK_LED_BLINK,
} pk_led_mode_t;

void pk_leds_init(void);
void pk_leds_activity(pk_led_mode_t mode);
void pk_leds_connection(pk_led_mode_t mode);
// Lights button LED 0-4 (A-E) for a moment.
void pk_leds_button(int index);
void pk_leds_all_off(void);
void pk_leds_tick(void);

#endif // PK_LEDS_H
