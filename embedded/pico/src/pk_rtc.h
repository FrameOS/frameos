// PCF85063A RTC on the Inky Frame (i2c0, addr 0x51): countdown-timer wake +
// the HOLD_VSYS power cut. sleep_minutes() powers the board OFF (~20uA);
// wake is a cold boot. On USB power the latch cannot cut VSYS, so the call
// returns after the timeout instead (caller keeps looping).
#ifndef PK_RTC_H
#define PK_RTC_H

#include <stdbool.h>
#include <stdint.h>

bool pk_rtc_present(void);
void pk_rtc_init(void);
// Never returns on battery; returns after ~minutes on USB power.
void pk_rtc_sleep_minutes(uint32_t minutes);

#endif // PK_RTC_H
