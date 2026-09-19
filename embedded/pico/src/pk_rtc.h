// PCF85063A RTC on the Inky Frame (i2c0, addr 0x51): countdown-timer wake +
// the HOLD_VSYS power cut, and a battery-backed clock. pk_rtc_sleep() powers
// the board OFF (~20uA); wake is a cold boot. On USB power the latch cannot
// cut VSYS, so the call returns after the timeout instead (caller keeps
// looping).
#ifndef PK_RTC_H
#define PK_RTC_H

#include <stdbool.h>
#include <stdint.h>

// The countdown timer is 8 bits: whole seconds up to 255, then whole minutes
// up to 255 (4 h 15 min). A longer interval wakes early, finds the frame
// unchanged, skips the refresh and goes back to sleep.
#define PK_RTC_MAX_SLEEP_SECONDS (255u * 60u)

bool pk_rtc_present(void);
void pk_rtc_init(void);
// Never returns on battery; returns after ~seconds on USB power (or at once
// when `abort` says so — a console line, a button — so USB stays usable).
// Refuses to cut the power when the wake timer could not be armed.
void pk_rtc_sleep(uint32_t seconds, bool (*abort)(void));

// Arms the countdown without cutting power: "if the 3V3 rail drops in the
// next `seconds`, bring the board back". On battery every reset is a power
// cut — a watchdog or software reset floats HOLD_VSYS_EN — so this is armed
// before a deliberate reboot, and kept armed as a dead-man timer while the
// firmware runs so a watchdog reset is followed by a wake instead of a frame
// that stays dark until somebody presses a button. False when there is no
// RTC or it did not take the timer.
bool pk_rtc_arm_wake(uint32_t seconds);

// The RTC's clock as Unix epoch seconds; 0 when it lost power or was never
// set. Set from SNTP so the next cold boot knows the time before the network
// is up (TLS validity checks, log timestamps).
uint32_t pk_rtc_read_epoch(void);
void pk_rtc_write_epoch(uint32_t epoch);

#endif // PK_RTC_H
