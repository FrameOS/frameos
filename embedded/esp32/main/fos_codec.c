#include "fos_codec.h"

#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

#include "fos_config.h"
#include "fos_i2c.h"
#include "fos_i2s.h"

static const char *TAG = "fos_codec";

#if SOC_I2S_HW_VERSION_2
#include "esp_heap_caps.h"
#include "esp_private/gdma.h"
#include "esp_private/gpio.h"
#include "esp_private/periph_ctrl.h"
#include "esp_rom_gpio.h"
#include "hal/gpio_hal.h"
#include "hal/i2s_ll.h"
#include "soc/gpio_sig_map.h"
#include "soc/lldesc.h"

#define CODEC_I2S_PORT 0
#define CODEC_HW (&I2S0)
/* PLL 160 MHz / (39 + 1/16) = 4.096 MHz = 256 x 16 kHz; bclk = mclk / 8 =
 * 512 kHz = 16 kHz x 2 slots x 16 bits. */
#define CODEC_MCLK_DIV_INT 39
#define CODEC_MCLK_DIV_NUM 1
#define CODEC_MCLK_DIV_DEN 16
#define CODEC_BCLK_DIV 8
/* The tone ring: 32 ms of 16-bit mono, looped by the DMA with no CPU in
 * between, so a tone is written once. 1 KB of internal RAM, claimed at init
 * on a codec board only. */
#define TONE_SAMPLES 512
#define TONE_BYTES (TONE_SAMPLES * 2)
#define TONE_STEP_HZ (FOS_CODEC_SAMPLE_RATE / TONE_SAMPLES) /* 31.25, as an integer 31 */
#define TONE_AMPLITUDE 6000

static gdma_channel_handle_t s_tx_dma = NULL;
static lldesc_t *s_tx_desc = NULL;
static int16_t *s_tone = NULL;
static bool s_tx_running = false;
#endif

static bool s_ready = false;
static bool s_has_mic = false;
static bool s_has_speaker = false;
static SemaphoreHandle_t s_lock = NULL;
static int s_pa_pin = -1;
/* Who needs the clocks: the microphone (RX) and a tone (TX). */
static bool s_rx_on = false;
static bool s_tone_on = false;

/* ------------------------------------------------------------ the chips */

static esp_err_t w8(fos_i2c_chip_t chip, uint8_t reg, uint8_t value)
{
    return fos_i2c_write(chip, reg, &value, 1);
}

/* The ES8311 as esp-bsp's es8311_init + es8311_sample_frequency_config set it
 * for 16 kHz with a 4.096 MHz MCLK on the MCLK pin, I2S slave, 16-bit both
 * ways (coefficient row {4096000, 16000}: pre_div 1, mult 0, adc/dac div 1,
 * fs_mode 0, lrck 0x00ff, bclk_div 4, osr 0x10). A row with a `keep` mask
 * is a read-modify-write: the chip's other bits in that register are its own. */
static esp_err_t es8311_setup(void)
{
    static const struct {
        uint8_t reg, keep, set;
    } sequence[] = {
        {0x00, 0x00, 0x00}, {0x00, 0x00, 0x80}, /* out of reset, power on */
        {0x01, 0x00, 0x3F},                     /* all clocks on, MCLK from the pin */
        {0x06, 0xDF, 0x00},                     /* SCLK not inverted */
        {0x02, 0x07, 0x00},                     /* pre_div 1, no multiplier */
        {0x03, 0x00, 0x10}, {0x04, 0x00, 0x10}, /* single speed; ADC and DAC osr */
        {0x05, 0x00, 0x00},                     /* ADC and DAC dividers 1 */
        {0x06, 0xE0, 0x03},                     /* bclk div 4 */
        {0x07, 0xC0, 0x00}, {0x08, 0x00, 0xFF}, /* lrck divider */
        {0x00, 0xBF, 0x00},                     /* I2S slave */
        {0x09, 0x00, 0x0C}, {0x0A, 0x00, 0x0C}, /* SDP in / out: 16-bit I2S */
        {0x0D, 0x00, 0x01}, {0x0E, 0x00, 0x02}, /* analog power; PGA, ADC modulator */
        {0x12, 0x00, 0x00}, {0x13, 0x00, 0x10}, /* DAC power up; output to the HP drive */
        {0x1C, 0x00, 0x6A}, {0x37, 0x00, 0x08}, /* equalizer bypasses */
        {0x32, 0x00, 0xBF},                     /* volume: es8311_voice_volume_set(75) */
    };
    esp_err_t err = w8(FOS_I2C_ES8311, 0x00, 0x1F); /* reset */
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(20));
    for (size_t i = 0; i < sizeof(sequence) / sizeof(sequence[0]); i++) {
        uint8_t value = sequence[i].set;
        if (sequence[i].keep) {
            uint8_t current = 0;
            err = fos_i2c_read(FOS_I2C_ES8311, sequence[i].reg, &current, 1);
            if (err != ESP_OK) return err;
            value |= (uint8_t)(current & sequence[i].keep);
        }
        err = w8(FOS_I2C_ES8311, sequence[i].reg, value);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}

/* The ES7210 as esp-bsp's es7210_config_codec sets it: I2S slave, 16-bit,
 * no TDM, 30 dB microphone gain, 2.87 V bias, 16 kHz from a 4.096 MHz MCLK
 * (coefficient row {4096000, 16000}: adc_div 1, dll 1, doubler 1, osr 0x20,
 * lrck 0x0100). */
static esp_err_t es7210_setup(void)
{
    static const uint8_t sequence[][2] = {
        {0x00, 0xFF}, {0x00, 0x32},                             /* reset */
        {0x09, 0x30}, {0x0A, 0x30},                             /* power-up timing */
        {0x23, 0x2A}, {0x22, 0x0A}, {0x21, 0x2A}, {0x20, 0x0A}, /* high-pass filters */
        {0x11, 0x60}, {0x12, 0x00},                             /* I2S, 16-bit, no TDM */
        {0x40, 0xC3},                                           /* analog power, VMID */
        {0x41, 0x70}, {0x42, 0x70},                             /* mic bias 2.87 V */
        {0x43, 0x1A}, {0x44, 0x1A}, {0x45, 0x1A}, {0x46, 0x1A}, /* mic gain 30 dB */
        {0x47, 0x08}, {0x48, 0x08}, {0x49, 0x08}, {0x4A, 0x08}, /* mic power */
        {0x07, 0x20}, {0x02, 0xC1}, {0x04, 0x01}, {0x05, 0x00}, /* 16 kHz @ 4.096 MHz */
        {0x06, 0x04},                                           /* DLL down */
        {0x4B, 0x0F}, {0x4C, 0x0F},                             /* bias, ADC, PGA on */
        {0x00, 0x71}, {0x00, 0x41},                             /* enable */
    };
    for (size_t i = 0; i < sizeof(sequence) / sizeof(sequence[0]); i++) {
        esp_err_t err = w8(FOS_I2C_ES7210, sequence[i][0], sequence[i][1]);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}

/* ------------------------------------------------------------- the I2S */

#if SOC_I2S_HW_VERSION_2
static void i2s_setup(const fos_codec_pins_t *pins)
{
    i2s_dev_t *hw = CODEC_HW;
    const hal_utils_clk_div_t mclk_div = {
        .integer = CODEC_MCLK_DIV_INT,
        .denominator = CODEC_MCLK_DIV_DEN,
        .numerator = CODEC_MCLK_DIV_NUM,
    };
    /* The controller's clocks and the receiver's 16-bit mono samples and
     * clock dividers, the way the PDM microphone has them (fos_mic.c). */
    fos_i2s_rx_prepare(&mclk_div, CODEC_BCLK_DIV, true);
    /* The transmitter (i2s_hal_std_set_tx_slot, HW version 2): master,
     * 16-bit slots, Philips (one bit shift), mono copied into both slots. */
    i2s_ll_tx_reset(hw);
    i2s_ll_tx_set_slave_mod(hw, false);
    i2s_ll_tx_set_sample_bit(hw, 16, 16);
    i2s_ll_tx_enable_msb_shift(hw, true);
    i2s_ll_tx_set_ws_width(hw, 16);
    i2s_ll_tx_enable_mono_mode(hw, true);
    i2s_ll_tx_select_std_slot(hw, I2S_STD_SLOT_LEFT);
    i2s_ll_tx_set_skip_mask(hw, false);
    i2s_ll_tx_set_half_sample_bit(hw, 16);
    i2s_ll_tx_set_ws_idle_pol(hw, false);
    i2s_ll_tx_set_bit_order(hw, false);
    i2s_ll_tx_enable_left_align(hw, false);
    i2s_ll_tx_enable_big_endian(hw, false);
    /* The receiver's slot format (i2s_hal_std_set_rx_slot): the left slot
     * alone, the shape fos_voice.c wants. */
    i2s_ll_rx_enable_msb_shift(hw, true);
    i2s_ll_rx_set_ws_width(hw, 16);
    i2s_ll_rx_select_std_slot(hw, I2S_STD_SLOT_LEFT);
    i2s_ll_rx_set_ws_idle_pol(hw, false);
    i2s_ll_rx_set_bit_order(hw, false);
    i2s_ll_rx_enable_left_align(hw, false);
    i2s_ll_rx_enable_big_endian(hw, false);
    /* One clock for both (i2s_hal_set_tx_clock / _rx_clock, the full-duplex
     * driver's arrangement): the MCLK pin follows the transmitter, and the
     * receiver shares its bit and word clocks (sig_loopback). */
    PERIPH_RCC_ATOMIC() {
        i2s_ll_tx_enable_clock(hw);
        i2s_ll_mclk_bind_to_tx_clk(hw);
        i2s_ll_tx_clk_set_src(hw, I2S_CLK_SRC_PLL_160M);
    }
    i2s_ll_tx_set_mclk(hw, &mclk_div);
    i2s_ll_tx_set_bck_div_num(hw, CODEC_BCLK_DIV);
    i2s_ll_share_bck_ws(hw, true);
    i2s_ll_tx_enable_std(hw);
    i2s_ll_rx_enable_std(hw);
    /* The pins: the transmitter's clocks out, its data out, the ADC's data
     * in (i2s_std_set_gpio). */
    if (pins->mclk >= 0) {
        gpio_func_sel((gpio_num_t)pins->mclk, PIN_FUNC_GPIO);
        esp_rom_gpio_connect_out_signal(pins->mclk, I2S0_MCLK_OUT_IDX, false, false);
    }
    gpio_func_sel((gpio_num_t)pins->bclk, PIN_FUNC_GPIO);
    esp_rom_gpio_connect_out_signal(pins->bclk, I2S0O_BCK_OUT_IDX, false, false);
    gpio_func_sel((gpio_num_t)pins->ws, PIN_FUNC_GPIO);
    esp_rom_gpio_connect_out_signal(pins->ws, I2S0O_WS_OUT_IDX, false, false);
    if (pins->dout >= 0) {
        gpio_func_sel((gpio_num_t)pins->dout, PIN_FUNC_GPIO);
        esp_rom_gpio_connect_out_signal(pins->dout, I2S0O_SD_OUT_IDX, false, false);
    }
    if (pins->din >= 0) {
        gpio_func_sel((gpio_num_t)pins->din, PIN_FUNC_GPIO);
        gpio_input_enable((gpio_num_t)pins->din);
        esp_rom_gpio_connect_in_signal(pins->din, I2S0I_SD_IN_IDX, false);
    }
}

static esp_err_t tone_ring_setup(void)
{
    s_tone = heap_caps_calloc(1, TONE_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_tx_desc = heap_caps_calloc(2, sizeof(lldesc_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!s_tone || !s_tx_desc) return ESP_ERR_NO_MEM;
    for (int i = 0; i < 2; i++) {
        s_tx_desc[i].owner = 1;
        s_tx_desc[i].eof = 1;
        s_tx_desc[i].size = TONE_BYTES / 2;
        s_tx_desc[i].length = TONE_BYTES / 2;
        s_tx_desc[i].buf = (uint8_t *)s_tone + (size_t)i * (TONE_BYTES / 2);
        s_tx_desc[i].empty = (uint32_t)&s_tx_desc[(i + 1) % 2];
    }
    gdma_channel_alloc_config_t alloc = {.direction = GDMA_CHANNEL_DIRECTION_TX};
    esp_err_t err = gdma_new_ahb_channel(&alloc, &s_tx_dma);
    if (err != ESP_OK) return err;
    return gdma_connect(s_tx_dma, GDMA_MAKE_TRIGGER(GDMA_TRIG_PERIPH_I2S, 0));
}

/* The transmitter runs whenever anything needs the clocks: a tone, or the
 * receiver (which takes its bit clock from it). Silence is a ring of zeros. */
static void tx_run_locked(bool run)
{
    if (run == s_tx_running) return;
    i2s_dev_t *hw = CODEC_HW;
    if (run) {
        i2s_ll_tx_reset(hw);
        gdma_reset(s_tx_dma);
        i2s_ll_tx_reset_fifo(hw);
        gdma_start(s_tx_dma, (intptr_t)&s_tx_desc[0]);
        i2s_ll_tx_start(hw);
    } else {
        i2s_ll_tx_stop(hw);
        gdma_stop(s_tx_dma);
    }
    s_tx_running = run;
}

static void fill_tone(uint32_t freq_hz)
{
    if (freq_hz == 0) {
        memset(s_tone, 0, TONE_BYTES);
        return;
    }
    /* Whole periods per ring, so the loop seam is silent: 2000 Hz is 64 of
     * them, 70 Hz rounds to 2 (62.5 Hz). */
    uint32_t periods = (freq_hz * TONE_SAMPLES + FOS_CODEC_SAMPLE_RATE / 2) / FOS_CODEC_SAMPLE_RATE;
    if (periods == 0) periods = 1;
    if (periods > TONE_SAMPLES / 2) periods = TONE_SAMPLES / 2;
    uint32_t half = TONE_SAMPLES / (2 * periods);
    for (uint32_t i = 0; i < TONE_SAMPLES; i++) {
        s_tone[i] = ((i / half) & 1) ? (int16_t)-TONE_AMPLITUDE : (int16_t)TONE_AMPLITUDE;
    }
}
#endif /* SOC_I2S_HW_VERSION_2 */

/* ------------------------------------------------------------- the API */

bool fos_codec_init(void)
{
    const fos_config_t *config = fos_config();
    const fos_codec_pins_t *pins = &config->codec_pins;
    if (pins->bclk < 0 || pins->ws < 0) return false;
#if !SOC_I2S_HW_VERSION_2
    ESP_LOGW(TAG, "no I2S codec support on this chip");
    return false;
#else
    s_has_mic = fos_i2c_present(FOS_I2C_ES7210) && pins->din >= 0;
    s_has_speaker = fos_i2c_present(FOS_I2C_ES8311) && pins->dout >= 0;
    if (!s_has_mic && !s_has_speaker) {
        ESP_LOGW(TAG, "codec pins set but no ES8311 / ES7210 answered on the I2C buses");
        return false;
    }
    const int candidates[] = {pins->mclk, pins->bclk, pins->ws, pins->din, pins->dout, pins->pa};
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        const char *why = candidates[i] >= 0 ? fos_config_gpio_pin_reserved(candidates[i]) : NULL;
        if (why) {
            ESP_LOGW(TAG, "codec GPIO %d refused: %s", candidates[i], why);
            s_has_mic = s_has_speaker = false;
            return false;
        }
    }
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return false;
    if (tone_ring_setup() != ESP_OK) {
        ESP_LOGW(TAG, "no DMA for the codec");
        s_has_mic = s_has_speaker = false;
        return false;
    }
    i2s_setup(pins);
    if (s_has_speaker && es8311_setup() != ESP_OK) {
        ESP_LOGW(TAG, "ES8311 did not take its configuration");
        s_has_speaker = false;
    }
    if (s_has_mic && es7210_setup() != ESP_OK) {
        ESP_LOGW(TAG, "ES7210 did not take its configuration");
        s_has_mic = false;
    }
    if (pins->pa >= 0 && s_has_speaker) {
        gpio_config_t io = {
            .pin_bit_mask = 1ULL << pins->pa,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        if (gpio_config(&io) == ESP_OK) {
            gpio_set_level((gpio_num_t)pins->pa, 0);
            s_pa_pin = pins->pa;
        }
    }
    s_ready = s_has_mic || s_has_speaker;
    /* printf: INFO is compiled out, and this is the line that says what the
     * board has. */
    printf("codec: speaker=%d microphone=%d\n", (int)s_has_speaker, (int)s_has_mic);
    return s_ready;
#endif
}

bool fos_codec_has_mic(void)
{
    return s_ready && s_has_mic;
}

bool fos_codec_has_speaker(void)
{
    return s_ready && s_has_speaker;
}

esp_err_t fos_codec_rx_begin(size_t eof_bytes)
{
#if !SOC_I2S_HW_VERSION_2
    (void)eof_bytes;
    return ESP_ERR_NOT_SUPPORTED;
#else
    if (!fos_codec_has_mic()) return ESP_ERR_NOT_FOUND;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    i2s_ll_rx_set_eof_num(CODEC_HW, (int)eof_bytes);
    s_rx_on = true;
    tx_run_locked(true);
    xSemaphoreGive(s_lock);
    return ESP_OK;
#endif
}

void fos_codec_rx_end(void)
{
#if SOC_I2S_HW_VERSION_2
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_rx_on = false;
    if (!s_tone_on) tx_run_locked(false);
    xSemaphoreGive(s_lock);
#endif
}

void fos_codec_tone(uint32_t freq_hz)
{
#if !SOC_I2S_HW_VERSION_2
    (void)freq_hz;
#else
    if (!fos_codec_has_speaker()) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    fill_tone(freq_hz);
    s_tone_on = freq_hz != 0;
    if (s_pa_pin >= 0) gpio_set_level((gpio_num_t)s_pa_pin, s_tone_on ? 1 : 0);
    tx_run_locked(s_tone_on || s_rx_on);
    xSemaphoreGive(s_lock);
#endif
}
