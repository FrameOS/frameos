/* Test shim for test_busy_budget.nim: the shared ePaper/DEV_Debug.c on a
 * fake clock and a fake BUSY pin. fake_hal/ shadows lgpio.h so this builds
 * on any host. */
#include "../ePaper/DEV_Debug.c"

int EPD_RST_PIN = 1;
int EPD_DC_PIN = 2;
int EPD_CS_PIN = 3;
int EPD_CS_S_PIN = -1;
int EPD_BUSY_PIN = 4;
int EPD_PWR_PIN = -1;

static UDOUBLE s_fake_now_ms = 0;
static UDOUBLE s_fake_busy_until_ms = 0;
static int s_fake_busy_forever = 0;
static char s_fake_error[256] = "";

UDOUBLE DEV_Millis(void) { return s_fake_now_ms; }
void DEV_Delay_ms(UDOUBLE xms) { s_fake_now_ms += xms; }

/* BUSY reads 1 (busy) while the fake panel is busy. */
UBYTE DEV_Digital_Read(UWORD Pin)
{
    if (Pin != (UWORD)EPD_BUSY_PIN) return 0;
    return (s_fake_busy_forever || s_fake_now_ms < s_fake_busy_until_ms) ? 1 : 0;
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
    vsnprintf(s_fake_error, sizeof(s_fake_error), fmt, args);
    va_end(args);
}

void fake_reset(void)
{
    s_fake_now_ms = 0;
    s_fake_busy_until_ms = 0;
    s_fake_busy_forever = 0;
    s_fake_error[0] = '\0';
    DEV_Busy_Budget_End();
}
void fake_set_busy_forever(int on) { s_fake_busy_forever = on; }
void fake_set_busy_for(UDOUBLE ms) { s_fake_busy_until_ms = s_fake_now_ms + ms; }
UDOUBLE fake_now_ms(void) { return s_fake_now_ms; }
const char *fake_last_error(void) { return s_fake_error; }
void fake_clear_error(void) { s_fake_error[0] = '\0'; }

/* The vendor drivers' own wait loop, in the shape all 73 of them share
 * (EPD_7in5_V2.c EPD_WaitUntilIdle): count their own elapsed time, compare
 * it with EPD_BUSY_TIMEOUT_MS on every poll, report through Debug(). */
int fake_vendor_wait(void)
{
    UDOUBLE busy_wait_ms = 0;
    do {
        if (busy_wait_ms >= EPD_BUSY_TIMEOUT_MS) {
            Debug("e-Paper busy timeout\r\n");
            return -1;
        }
        DEV_Delay_ms(20);
        busy_wait_ms += 20;
    } while (DEV_Digital_Read(EPD_BUSY_PIN) == 1);
    return 0;
}
