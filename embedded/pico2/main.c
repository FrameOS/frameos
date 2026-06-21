#include <stdio.h>
#include <string.h>

#include "hardware/gpio.h"
#include "pico/stdlib.h"

#if __has_include("generated_config.h")
#include "generated_config.h"
#endif

#ifndef FRAMEOS_DEFAULT_BACKEND_URL
#define FRAMEOS_DEFAULT_BACKEND_URL ""
#endif
#ifndef FRAMEOS_DEFAULT_API_KEY
#define FRAMEOS_DEFAULT_API_KEY ""
#endif
#ifndef FRAMEOS_DEFAULT_FRAME_ID
#define FRAMEOS_DEFAULT_FRAME_ID 0
#endif
#ifndef FRAMEOS_DEFAULT_HOSTNAME
#define FRAMEOS_DEFAULT_HOSTNAME "frameos-pico"
#endif
#ifndef FRAMEOS_DEFAULT_PANEL
#define FRAMEOS_DEFAULT_PANEL "none"
#endif
#ifndef FRAMEOS_DEFAULT_RENDER_MODE
#define FRAMEOS_DEFAULT_RENDER_MODE 1
#endif
#ifndef FRAMEOS_DEFAULT_INTERVAL_SEC
#define FRAMEOS_DEFAULT_INTERVAL_SEC 300
#endif
#ifndef FRAMEOS_DEFAULT_PIN_RST
#define FRAMEOS_DEFAULT_PIN_RST 21
#endif
#ifndef FRAMEOS_DEFAULT_PIN_DC
#define FRAMEOS_DEFAULT_PIN_DC 20
#endif
#ifndef FRAMEOS_DEFAULT_PIN_CS
#define FRAMEOS_DEFAULT_PIN_CS 17
#endif
#ifndef FRAMEOS_DEFAULT_PIN_CS2
#define FRAMEOS_DEFAULT_PIN_CS2 -1
#endif
#ifndef FRAMEOS_DEFAULT_PIN_BUSY
#define FRAMEOS_DEFAULT_PIN_BUSY 16
#endif
#ifndef FRAMEOS_DEFAULT_PIN_SCK
#define FRAMEOS_DEFAULT_PIN_SCK 18
#endif
#ifndef FRAMEOS_DEFAULT_PIN_MOSI
#define FRAMEOS_DEFAULT_PIN_MOSI 19
#endif
#ifndef FRAMEOS_DEFAULT_PIN_PWR
#define FRAMEOS_DEFAULT_PIN_PWR -1
#endif
#ifndef FRAMEOS_DEFAULT_PLATFORM
#define FRAMEOS_DEFAULT_PLATFORM "pico"
#endif
#ifndef FRAMEOS_PICO_BOARD_NAME
#define FRAMEOS_PICO_BOARD_NAME "pico"
#endif

static void print_status(void) {
    printf("{\"event\":\"status\",\"source\":\"pico\",\"platform\":\"%s\","
           "\"board\":\"%s\",\"frameId\":%d,"
           "\"hostname\":\"%s\",\"backend\":\"%s\",\"panel\":\"%s\","
           "\"renderMode\":%d,\"intervalSec\":%d,"
           "\"pins\":{\"rst\":%d,\"dc\":%d,\"cs\":%d,\"cs2\":%d,"
           "\"busy\":%d,\"sck\":%d,\"mosi\":%d,\"pwr\":%d}}\n",
           FRAMEOS_DEFAULT_PLATFORM,
           FRAMEOS_PICO_BOARD_NAME,
           FRAMEOS_DEFAULT_FRAME_ID,
           FRAMEOS_DEFAULT_HOSTNAME,
           FRAMEOS_DEFAULT_BACKEND_URL,
           FRAMEOS_DEFAULT_PANEL,
           FRAMEOS_DEFAULT_RENDER_MODE,
           FRAMEOS_DEFAULT_INTERVAL_SEC,
           FRAMEOS_DEFAULT_PIN_RST,
           FRAMEOS_DEFAULT_PIN_DC,
           FRAMEOS_DEFAULT_PIN_CS,
           FRAMEOS_DEFAULT_PIN_CS2,
           FRAMEOS_DEFAULT_PIN_BUSY,
           FRAMEOS_DEFAULT_PIN_SCK,
           FRAMEOS_DEFAULT_PIN_MOSI,
           FRAMEOS_DEFAULT_PIN_PWR);
}

static void print_help(void) {
    puts("FrameOS Pico commands:");
    puts("  status  print baked frame identity and display wiring");
    puts("  ping    print pong");
    puts("  help    print this help");
}

static void handle_line(char *line) {
    char *end = line + strlen(line);
    while (end > line && (end[-1] == '\r' || end[-1] == '\n' || end[-1] == ' ' || end[-1] == '\t')) {
        *--end = '\0';
    }
    if (strcmp(line, "status") == 0) {
        print_status();
    } else if (strcmp(line, "ping") == 0) {
        puts("{\"event\":\"pong\",\"source\":\"pico\"}");
    } else if (strcmp(line, "help") == 0 || strcmp(line, "?") == 0) {
        print_help();
    } else if (line[0] != '\0') {
        printf("{\"event\":\"error\",\"source\":\"pico\",\"message\":\"unknown command: %s\"}\n", line);
    }
}

int main(void) {
    stdio_init_all();

#ifdef PICO_DEFAULT_LED_PIN
    const uint led_pin = PICO_DEFAULT_LED_PIN;
    gpio_init(led_pin);
    gpio_set_dir(led_pin, GPIO_OUT);
#endif

    sleep_ms(1500);
    printf("{\"event\":\"bootup\",\"source\":\"pico\",\"platform\":\"%s\","
           "\"board\":\"%s\",\"flashMB\":4,\"sramKB\":520}\n",
           FRAMEOS_DEFAULT_PLATFORM,
           FRAMEOS_PICO_BOARD_NAME);
    print_status();
    print_help();

    char line[96];
    size_t line_len = 0;
#ifdef PICO_DEFAULT_LED_PIN
    absolute_time_t next_blink = make_timeout_time_ms(500);
    bool led = false;
#endif

    while (true) {
        int ch = getchar_timeout_us(1000);
        if (ch != PICO_ERROR_TIMEOUT) {
            if (ch == '\r' || ch == '\n') {
                line[line_len] = '\0';
                handle_line(line);
                line_len = 0;
            } else if (line_len + 1 < sizeof(line)) {
                line[line_len++] = (char) ch;
            }
        }

#ifdef PICO_DEFAULT_LED_PIN
        if (absolute_time_diff_us(get_absolute_time(), next_blink) <= 0) {
            led = !led;
            gpio_put(led_pin, led);
            next_blink = make_timeout_time_ms(1000);
        }
#endif
    }
}
