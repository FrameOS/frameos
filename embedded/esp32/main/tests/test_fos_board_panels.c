/*
 * Host test: which panels a board can be pushed (fos_board_panels.c, the
 * `device` half of set_settings) against the `panels` cases of
 * docs/cloud-frames-fixtures.json — the cases the cloud and the SPA run too.
 * The fixture's `compiled` map stands in for the firmware's panel table,
 * which is generated from the driver sources at build time.
 *
 * Build and run (from the repo root), with cJSON from ESP-IDF:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -O2 -Iembedded/esp32/main \
 *      -I$IDF_PATH/components/json/cJSON $IDF_PATH/components/json/cJSON/cJSON.c \
 *      embedded/esp32/main/fos_board_panels.c \
 *      embedded/esp32/main/tests/test_fos_board_panels.c -lm \
 *      -o /tmp/test_fos_board_panels && \
 *   /tmp/test_fos_board_panels docs/cloud-frames-fixtures.json
 *
 * (backend/app/tasks/tests/test_esp32_board_panels.py does exactly that in CI.)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "fos_board_panels.h"

static const cJSON *s_compiled = NULL;

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)len + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t got = fread(buf, 1, (size_t)len, f);
    fclose(f);
    buf[got] = '\0';
    return buf;
}

static bool fixture_facts(const char *panel, int *bus, bool *requires_cs2)
{
    const cJSON *entry = cJSON_GetObjectItemCaseSensitive(s_compiled, panel);
    if (!cJSON_IsObject(entry)) return false;
    const cJSON *bus_name = cJSON_GetObjectItemCaseSensitive(entry, "bus");
    *bus = cJSON_IsString(bus_name) && strcmp(bus_name->valuestring, "i2c") == 0
        ? FOS_PANEL_BUS_I2C : FOS_PANEL_BUS_SPI;
    *requires_cs2 = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(entry, "requiresCs2"));
    return true;
}

static int pin(const cJSON *pins, const char *name)
{
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(pins, name);
    return cJSON_IsNumber(value) ? value->valueint : -1;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s docs/cloud-frames-fixtures.json\n", argv[0]);
        return 2;
    }
    char *text = read_file(argv[1]);
    cJSON *doc = text ? cJSON_Parse(text) : NULL;
    const cJSON *panels = cJSON_GetObjectItemCaseSensitive(doc, "panels");
    const cJSON *cases = cJSON_GetObjectItemCaseSensitive(panels, "cases");
    s_compiled = cJSON_GetObjectItemCaseSensitive(panels, "compiled");
    if (!cJSON_IsArray(cases) || !cJSON_IsObject(s_compiled)) {
        fprintf(stderr, "no panels section in %s\n", argv[1]);
        return 2;
    }

    int failures = 0;
    int checks = 0;
    const cJSON *item = NULL;
    cJSON_ArrayForEach(item, cases) {
        const char *name = cJSON_GetObjectItemCaseSensitive(item, "name")->valuestring;
        const cJSON *board = cJSON_GetObjectItemCaseSensitive(item, "board");
        const cJSON *preset = cJSON_GetObjectItemCaseSensitive(board, "hardwarePreset");
        const cJSON *pins = cJSON_GetObjectItemCaseSensitive(board, "pins");
        const fos_panel_wiring_t wiring = {
            .rst = pin(pins, "rst"),
            .dc = pin(pins, "dc"),
            .cs = pin(pins, "cs"),
            .cs2 = pin(pins, "cs2"),
            .busy = pin(pins, "busy"),
            .sck = pin(pins, "sck"),
            .mosi = pin(pins, "mosi"),
        };
        const char *device = cJSON_GetObjectItemCaseSensitive(item, "device")->valuestring;
        const char *expect = cJSON_GetObjectItemCaseSensitive(item, "expect")->valuestring;
        const char *got = fos_board_panel_refusal(cJSON_IsString(preset) ? preset->valuestring : "",
                                                  &wiring, device, fixture_facts);
        const char *verdict = got ? got : "ok";
        checks++;
        if (strcmp(verdict, expect) != 0) {
            failures++;
            printf("FAIL %s: %s -> %s, want %s\n", name, device, verdict, expect);
        }
    }

    /* The name a plane's key resolves to, which is what the firmware stores. */
    char out[64];
    checks++;
    if (!fos_board_panel_name("waveshare.EPD_7in3e", out, sizeof(out)) || strcmp(out, "EPD_7in3e") != 0) {
        failures++;
        printf("FAIL waveshare.EPD_7in3e resolves to %s\n", out);
    }
    checks++;
    if (!fos_board_panel_name("oled.ssd1306_72x40", out, sizeof(out)) ||
        strcmp(out, "OLED_SSD1306_72x40") != 0) {
        failures++;
        printf("FAIL oled.ssd1306_72x40 resolves to %s\n", out);
    }
    checks++;
    if (fos_board_panel_name("waveshare.EPD_7in3e", out, 5)) {
        failures++;
        printf("FAIL a name longer than the buffer must not resolve\n");
    }

    printf("%d checks, %d failures\n", checks, failures);
    cJSON_Delete(doc);
    free(text);
    return failures == 0 ? 0 : 1;
}
