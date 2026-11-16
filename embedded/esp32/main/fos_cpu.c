#include "fos_cpu.h"

#include "esp_private/esp_clk.h"
#include "soc/rtc.h"

void fos_cpu_set_mhz(int mhz)
{
#if CONFIG_IDF_TARGET_ESP32S3
    if (fos_cpu_mhz() == mhz) return;
    rtc_cpu_freq_config_t cpu;
    if (rtc_clk_cpu_freq_mhz_to_config((uint32_t)mhz, &cpu)) rtc_clk_cpu_freq_set_config(&cpu);
#else
    (void)mhz;
#endif
}

int fos_cpu_mhz(void)
{
    return (int)(esp_clk_cpu_freq() / 1000000);
}
