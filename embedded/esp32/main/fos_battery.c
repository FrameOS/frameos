#include "fos_battery.h"

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "fos_battery";

#define BATTERY_SAMPLES 16

static bool s_present = false;
static float s_divider = 2.0f;
static int8_t s_enable_gpio = -1;
static adc_oneshot_unit_handle_t s_adc = NULL;
static adc_channel_t s_channel;
static adc_cali_handle_t s_cali = NULL; /* NULL = fall back to linear estimate */
/* Enable → settle → sample → disable is one critical section: a second
 * caller's trailing "divider off" landing mid-sample averages zeros into a
 * full cell (read as ~1.9 V, i.e. "critical"). */
static SemaphoreHandle_t s_lock = NULL;

void fos_battery_init(int8_t gpio, float divider, int8_t enable_gpio)
{
    s_present = false;
    s_cali = NULL;
    s_adc = NULL;
    if (gpio < 0) {
        ESP_LOGI(TAG, "no battery pin configured");
        return;
    }
    s_divider = divider > 0.1f ? divider : 2.0f;
    s_enable_gpio = enable_gpio;
    if (s_lock == NULL) s_lock = xSemaphoreCreateMutex();
    if (enable_gpio >= 0) {
        /* Off between reads, the way Seeed's Battery_Monitor example does it:
         * the divider only draws from the cell while a sample is taken. */
        gpio_reset_pin(enable_gpio);
        gpio_set_direction(enable_gpio, GPIO_MODE_OUTPUT);
        gpio_set_level(enable_gpio, 0);
    }

    adc_unit_t unit;
    adc_channel_t channel;
    if (adc_oneshot_io_to_channel(gpio, &unit, &channel) != ESP_OK) {
        ESP_LOGW(TAG, "GPIO %d is not an ADC pin; battery sensing off", gpio);
        return;
    }
    if (unit != ADC_UNIT_1) {
        /* ADC2 shares hardware with Wi-Fi and stalls while connected. */
        ESP_LOGW(TAG, "GPIO %d is on ADC2 (conflicts with Wi-Fi); use an ADC1 pin", gpio);
        return;
    }
    s_channel = channel;

    adc_oneshot_unit_init_cfg_t unit_cfg = {.unit_id = ADC_UNIT_1};
    if (adc_oneshot_new_unit(&unit_cfg, &s_adc) != ESP_OK) {
        ESP_LOGE(TAG, "adc_oneshot_new_unit failed");
        return;
    }
    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12, /* full-scale ~0..3.1V at the pin */
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_oneshot_config_channel(s_adc, s_channel, &chan_cfg) != ESP_OK) {
        ESP_LOGE(TAG, "adc_oneshot_config_channel failed");
        adc_oneshot_del_unit(s_adc);
        s_adc = NULL;
        return;
    }

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .chan = s_channel,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_cali) != ESP_OK) {
        ESP_LOGW(TAG, "ADC calibration unavailable; using a rough linear estimate");
        s_cali = NULL;
    }
#endif

    s_present = true;
    ESP_LOGI(TAG, "battery sensing on GPIO %d (ADC1 ch %d, divider %.2f, cali %s, enable GPIO %d)",
             gpio, (int)s_channel, s_divider, s_cali ? "yes" : "no", (int)enable_gpio);
}

bool fos_battery_present(void) { return s_present; }

/* The averaged raw ADC reading with the divider switched on; -1 when no
 * sample came back. Caller holds s_lock. */
static int sample_raw_locked(void)
{
    if (s_enable_gpio >= 0) {
        /* Seeed: enable, wait ~10 ms for the divider to settle, read. */
        gpio_set_level(s_enable_gpio, 1);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    int raw_sum = 0, samples = 0;
    for (int i = 0; i < BATTERY_SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, s_channel, &raw) == ESP_OK) {
            raw_sum += raw;
            samples++;
        }
    }
    if (s_enable_gpio >= 0) gpio_set_level(s_enable_gpio, 0);
    return samples == 0 ? -1 : raw_sum / samples;
}

static int millivolts_from_raw(int raw)
{
    if (raw < 0) return 0;
    int pin_mv;
    if (s_cali) {
        if (adc_cali_raw_to_voltage(s_cali, raw, &pin_mv) != ESP_OK) return 0;
    } else {
        /* No calibration: assume the default 12-bit / 3.1V full scale. */
        pin_mv = (int)((float)raw * 3100.0f / 4095.0f);
    }
    return (int)((float)pin_mv * s_divider);
}

static int percent_from_millivolts(int mv)
{
    if (mv <= 0) return -1;
    /* Coarse Li-ion discharge curve (resting voltage → state of charge). */
    static const struct { int mv; int pct; } CURVE[] = {
        {4200, 100}, {4100, 90}, {4000, 80}, {3900, 70}, {3800, 60},
        {3700, 50}, {3600, 35}, {3500, 20}, {3400, 10}, {3300, 5}, {3000, 0},
    };
    const int n = sizeof(CURVE) / sizeof(CURVE[0]);
    if (mv >= CURVE[0].mv) return 100;
    if (mv <= CURVE[n - 1].mv) return 0;
    for (int i = 0; i < n - 1; i++) {
        if (mv <= CURVE[i].mv && mv > CURVE[i + 1].mv) {
            int span_mv = CURVE[i].mv - CURVE[i + 1].mv;
            int span_pct = CURVE[i].pct - CURVE[i + 1].pct;
            return CURVE[i + 1].pct + (mv - CURVE[i + 1].mv) * span_pct / span_mv;
        }
    }
    return -1;
}

void fos_battery_read(int *millivolts, int *percent)
{
    int mv = 0;
    if (s_present && s_adc) {
        bool locked = s_lock != NULL && xSemaphoreTake(s_lock, portMAX_DELAY) == pdTRUE;
        mv = millivolts_from_raw(sample_raw_locked());
        if (locked) xSemaphoreGive(s_lock);
    }
    if (millivolts) *millivolts = mv;
    if (percent) *percent = percent_from_millivolts(mv);
}

int fos_battery_millivolts(void)
{
    int mv = 0;
    fos_battery_read(&mv, NULL);
    return mv;
}

int fos_battery_percent(void)
{
    int pct = -1;
    fos_battery_read(NULL, &pct);
    return pct;
}
