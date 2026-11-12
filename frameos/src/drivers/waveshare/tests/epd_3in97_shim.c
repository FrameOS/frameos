/* Test shim for test_epd_3in97_busy.nim: the reTerminal Sticky's SSD1677
 * driver (ePaper/EPD_3in97.c) on a fake bus, a fake BUSY pin and a fake
 * clock. The fake controller is busy for a while after each activation (0x20)
 * and after a software reset (0x12), and records every byte the driver puts
 * on the bus while it is busy, and every hardware reset that cuts a running
 * waveform short: the controller takes no command while BUSY is high, so
 * either is a picture that never makes it to the glass. fake_hal/ shadows
 * lgpio.h so this builds on any host. The driver and DEV_Debug.c are compiled
 * as they are, each on its own (the test's {.compile.}), not included here:
 * Nim rebuilds a C file when it changes, never when a file it includes does. */
#include <stdarg.h>

#include "../ePaper/DEV_Config.h"

int EPD_RST_PIN = 1;
int EPD_DC_PIN = 2;
int EPD_CS_PIN = 3;
int EPD_CS_S_PIN = -1;
int EPD_BUSY_PIN = 4;
int EPD_PWR_PIN = -1;

/* How long the fake controller stays busy. A full refresh (0x22 = 0xF7) is
 * seconds, a partial update (0x0C / 0xFC) half a second, turning the analog
 * supply off (0x03) a few milliseconds. */
#define FAKE_FULL_MS 3000u
#define FAKE_PARTIAL_MS 500u
#define FAKE_OTHER_MS 30u
#define FAKE_SWRESET_MS 10u

static UDOUBLE s_now_ms = 0;
static UDOUBLE s_busy_until_ms = 0;
static UBYTE s_dc = 1;
static int s_last_command = -1;
static UBYTE s_update_control = 0;
static int s_violations = 0;
static char s_first_violation[160] = "";
static int s_activations = 0;
static int s_partial_activations = 0;
static int s_full_activations = 0;
static unsigned long s_bytes = 0;
static char s_error[256] = "";

static int fake_busy_now(void) { return s_now_ms < s_busy_until_ms; }

static void violation(const char *what, int value)
{
    if (s_violations++ == 0) {
        snprintf(s_first_violation, sizeof(s_first_violation),
                 "%s 0x%02X at %lu ms, BUSY until %lu ms (last command 0x%02X)", what, value & 0xFF,
                 (unsigned long)s_now_ms, (unsigned long)s_busy_until_ms, s_last_command & 0xFF);
    }
}

UDOUBLE DEV_Millis(void) { return s_now_ms; }
void DEV_Delay_ms(UDOUBLE xms) { s_now_ms += xms; }

UBYTE DEV_Digital_Read(UWORD Pin)
{
    if (Pin == (UWORD)EPD_BUSY_PIN) return fake_busy_now() ? 1 : 0;
    return 0;
}

void DEV_Digital_Write(UWORD Pin, UBYTE Value)
{
    if (Pin == (UWORD)EPD_DC_PIN) s_dc = Value;
    if (Pin == (UWORD)EPD_RST_PIN && Value == 0 && fake_busy_now()) {
        violation("hardware reset", 0);
    }
    if (Pin == (UWORD)EPD_RST_PIN && Value == 0) s_busy_until_ms = s_now_ms; /* a reset ends any waveform */
}

static void fake_byte(UBYTE value)
{
    s_bytes++;
    if (fake_busy_now()) violation(s_dc ? "data" : "command", value);
    if (s_dc) {
        if (s_last_command == 0x22) s_update_control = value;
        return;
    }
    s_last_command = value;
    if (value == 0x12) {
        s_busy_until_ms = s_now_ms + FAKE_SWRESET_MS;
    } else if (value == 0x20) {
        s_activations++;
        UDOUBLE ms = FAKE_OTHER_MS;
        if (s_update_control == 0xF7) {
            ms = FAKE_FULL_MS;
            s_full_activations++;
        } else if (s_update_control == 0x0C || s_update_control == 0xFC) {
            ms = FAKE_PARTIAL_MS;
            s_partial_activations++;
        }
        s_busy_until_ms = s_now_ms + ms;
    }
}

void DEV_SPI_WriteByte(UBYTE Value) { fake_byte(Value); }

void DEV_SPI_Write_nByte(uint8_t *pData, uint32_t Len)
{
    /* One check for the run, not 100 per row: the first byte decides. */
    if (Len == 0) return;
    fake_byte(pData[0]);
    s_bytes += Len - 1;
}

int DEV_Debug_Enabled(void) { return 0; }
void DEV_Debug_Log(const char *action, const char *extraJson)
{
    (void)action;
    (void)extraJson;
}

void DEV_Error(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    vsnprintf(s_error, sizeof(s_error), fmt, args);
    va_end(args);
}

/* Back to a powered-down panel with nothing pending: the driver's own state
 * (an update owed, the analog supply) is cleared by a full init, which the
 * Nim side calls first. */
void fake_reset(void)
{
    s_now_ms = 0;
    s_busy_until_ms = 0;
    s_dc = 1;
    s_last_command = -1;
    s_update_control = 0;
    s_violations = 0;
    s_first_violation[0] = '\0';
    s_activations = 0;
    s_partial_activations = 0;
    s_full_activations = 0;
    s_bytes = 0;
    s_error[0] = '\0';
    DEV_Busy_Budget_End();
}

UDOUBLE fake_now_ms(void) { return s_now_ms; }
void fake_advance_ms(UDOUBLE ms) { s_now_ms += ms; }
int fake_busy(void) { return fake_busy_now(); }
/* BUSY high with no update the driver knows of: what a lost wait looks like. */
void fake_set_busy_for(UDOUBLE ms) { s_busy_until_ms = s_now_ms + ms; }
int fake_violations(void) { return s_violations; }
const char *fake_first_violation(void) { return s_first_violation; }
int fake_partial_activations(void) { return s_partial_activations; }
int fake_full_activations(void) { return s_full_activations; }
unsigned long fake_bytes(void) { return s_bytes; }
const char *fake_last_error(void) { return s_error; }

UDOUBLE fake_full_ms(void) { return FAKE_FULL_MS; }
UDOUBLE fake_partial_ms(void) { return FAKE_PARTIAL_MS; }
