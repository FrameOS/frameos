#pragma once

/* The CPU clock, switched at run time (160 or 240 MHz on the S3: both divide
 * the same 480 MHz PLL, so the PSRAM, flash and APB clocks do not move). */
void fos_cpu_set_mhz(int mhz);
int fos_cpu_mhz(void);
