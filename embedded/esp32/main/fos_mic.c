#include "fos_mic.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

#include "fos_config.h"

/* The S3's I2S0 decodes PDM into PCM in hardware (SOC_I2S_SUPPORTS_PDM2PCM).
 * ESP-IDF's I2S driver does the same job in ~14 KB of flash (i2s_common,
 * i2s_hal, i2s_pdm, hal_utils: channel registry, three modes, clock
 * arithmetic, power locks); this is the ~2 KB of it a 16 kHz mono PDM
 * microphone needs, on the HAL's register layer (hal/i2s_ll.h) and the GDMA
 * driver the panel's SPI already links. The register sequence is the IDF
 * driver's for PDM RX (i2s_pdm.c, i2s_hal.c), with the one clock the frame
 * ever asks for worked out by hand:
 *
 *   bclk = 16000 Hz * 64 (PDM over-sampling, DSR 8S) = 1.024 MHz
 *   bclk_div = 8 (the PDM minimum)      -> mclk = 8.192 MHz
 *   mclk = PLL 160 MHz / (19 + 17/32)   -> 8.192 MHz exactly
 */
#if SOC_I2S_SUPPORTS_PDM2PCM
#include <stdlib.h>
#include "esp_private/gdma.h"
#include "esp_private/gpio.h"
#include "esp_private/periph_ctrl.h"
#include "esp_heap_caps.h"
#include "esp_rom_gpio.h"
#include "hal/gpio_hal.h"
#include "hal/i2s_ll.h"
#include "soc/gpio_sig_map.h"
#include "soc/lldesc.h"
#endif

static const char *TAG = "fos_mic";

static bool s_active = false;
static int s_pwr_pin = -1;

/* The load switch and the microphone's own start-up: the MSM261 is specified
 * to settle within tens of milliseconds of power and clock; the session
 * drops its first 300 ms anyway (fos_voice.c), this only keeps the first
 * DMA reads from being pure start-up noise. */
#define MIC_POWER_SETTLE_MS 20

#if SOC_I2S_SUPPORTS_PDM2PCM

#define MIC_I2S_PORT 0
#define MIC_HW (&I2S0)
/* Six buffers of 32 ms, like the IDF driver's default: 6 KB of DMA-capable
 * internal RAM for the session, freed with it. The capture task
 * (fos_voice.c) reads every few milliseconds; a buffer the CPU never came
 * for is overwritten a round later, which is the right failure for audio. */
#define MIC_DMA_BUF_BYTES 1024
#define MIC_DMA_BUFS 6
#define MIC_BCLK_DIV 8
#define MIC_MCLK_DIV_INT 19
#define MIC_MCLK_DIV_NUM 17
#define MIC_MCLK_DIV_DEN 32

static gdma_channel_handle_t s_dma = NULL;
static lldesc_t *s_desc = NULL; /* MIC_DMA_BUFS descriptors, a ring */
static uint8_t *s_bufs = NULL;  /* MIC_DMA_BUFS * MIC_DMA_BUF_BYTES */
static QueueHandle_t s_filled = NULL;
static const uint8_t *s_reading = NULL; /* the buffer fos_mic_read is in */
static size_t s_read_pos = 0;
static int s_clk_pin = -1;
static int s_data_pin = -1;

/* A buffer is full: hand it to the reader. A reader that fell MIC_DMA_BUFS
 * behind loses the oldest, not the newest. */
static bool IRAM_ATTR on_rx_eof(gdma_channel_handle_t chan, gdma_event_data_t *event, void *user)
{
    (void)chan;
    (void)user;
    BaseType_t woke = pdFALSE;
    const uint8_t *buf = ((lldesc_t *)event->rx_eof_desc_addr)->buf;
    if (xQueueIsQueueFullFromISR(s_filled)) {
        const uint8_t *dropped;
        BaseType_t woke2 = pdFALSE;
        xQueueReceiveFromISR(s_filled, &dropped, &woke2);
        woke |= woke2;
    }
    BaseType_t woke3 = pdFALSE;
    xQueueSendFromISR(s_filled, &buf, &woke3);
    return (woke | woke3) == pdTRUE;
}

static void release_hw(void)
{
    i2s_ll_rx_stop(MIC_HW);
    if (s_dma) {
        gdma_stop(s_dma);
        gdma_disconnect(s_dma);
        gdma_del_channel(s_dma);
        s_dma = NULL;
    }
    PERIPH_RCC_ATOMIC() {
        i2s_ll_rx_disable_clock(MIC_HW);
        i2s_ll_enable_core_clock(MIC_HW, false);
        i2s_ll_enable_bus_clock(MIC_I2S_PORT, false);
    }
    if (s_clk_pin >= 0) {
        gpio_reset_pin((gpio_num_t)s_clk_pin);
        s_clk_pin = -1;
    }
    if (s_data_pin >= 0) {
        gpio_reset_pin((gpio_num_t)s_data_pin);
        s_data_pin = -1;
    }
    if (s_filled) {
        vQueueDelete(s_filled);
        s_filled = NULL;
    }
    free(s_desc);
    s_desc = NULL;
    free(s_bufs);
    s_bufs = NULL;
    s_reading = NULL;
    s_read_pos = 0;
}

static esp_err_t setup_dma(void)
{
    /* Descriptors and buffers in internal, DMA-capable RAM (the S3 cannot
     * DMA from PSRAM here). */
    s_desc = heap_caps_calloc(MIC_DMA_BUFS, sizeof(lldesc_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_bufs = heap_caps_calloc(MIC_DMA_BUFS, MIC_DMA_BUF_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_filled = xQueueCreate(MIC_DMA_BUFS, sizeof(const uint8_t *));
    if (!s_desc || !s_bufs || !s_filled) return ESP_ERR_NO_MEM;
    for (int i = 0; i < MIC_DMA_BUFS; i++) {
        s_desc[i].owner = 1;
        s_desc[i].eof = 1;
        s_desc[i].size = MIC_DMA_BUF_BYTES;
        s_desc[i].length = MIC_DMA_BUF_BYTES;
        s_desc[i].buf = s_bufs + (size_t)i * MIC_DMA_BUF_BYTES;
        s_desc[i].empty = (uint32_t)&s_desc[(i + 1) % MIC_DMA_BUFS];
    }
    gdma_channel_alloc_config_t alloc = { .direction = GDMA_CHANNEL_DIRECTION_RX };
    esp_err_t err = gdma_new_ahb_channel(&alloc, &s_dma);
    if (err != ESP_OK) return err;
    err = gdma_connect(s_dma, GDMA_MAKE_TRIGGER(GDMA_TRIG_PERIPH_I2S, 0));
    if (err != ESP_OK) return err;
    gdma_rx_event_callbacks_t callbacks = { .on_recv_eof = on_rx_eof };
    return gdma_register_rx_event_callbacks(s_dma, &callbacks, NULL);
}

static void setup_i2s(int clk_pin, int data_pin)
{
    i2s_dev_t *hw = MIC_HW;
    PERIPH_RCC_ATOMIC() {
        i2s_ll_enable_bus_clock(MIC_I2S_PORT, true);
        i2s_ll_reset_register(MIC_I2S_PORT);
        i2s_ll_enable_core_clock(hw, true);
    }
    /* The slot: one 16-bit PCM sample per frame from the left PDM slot
     * (i2s_hal_pdm_set_rx_slot for HW version 2, mono). */
    i2s_ll_rx_reset(hw);
    i2s_ll_rx_set_slave_mod(hw, false);
    i2s_ll_rx_set_sample_bit(hw, 16, 16);
    i2s_ll_rx_set_half_sample_bit(hw, 16);
    i2s_ll_rx_enable_mono_mode(hw, false);
    i2s_ll_rx_set_active_chan_mask(hw, I2S_PDM_SLOT_LEFT);
    i2s_ll_share_bck_ws(hw, false);
    /* The clock (i2s_hal_set_rx_clock), fixed at 16 kHz. */
    PERIPH_RCC_ATOMIC() {
        i2s_ll_rx_enable_clock(hw);
        i2s_ll_mclk_bind_to_rx_clk(hw);
        i2s_ll_rx_clk_set_src(hw, I2S_CLK_SRC_PLL_160M);
    }
    const hal_utils_clk_div_t mclk_div = {
        .integer = MIC_MCLK_DIV_INT,
        .denominator = MIC_MCLK_DIV_DEN,
        .numerator = MIC_MCLK_DIV_NUM,
    };
    i2s_ll_rx_set_mclk(hw, &mclk_div);
    i2s_ll_rx_set_bck_div_num(hw, MIC_BCLK_DIV);
    i2s_ll_rx_set_pdm_dsr(hw, I2S_PDM_DSR_8S);
    i2s_ll_rx_enable_pdm(hw, true);
    /* One DMA buffer per EOF. */
    i2s_ll_rx_set_eof_num(hw, MIC_DMA_BUF_BYTES);
    /* The pins: the PDM clock is the RX word select, the data line the RX
     * data in (i2s_pdm_rx_set_gpio / i2s_gpio_check_and_set). */
    gpio_func_sel((gpio_num_t)clk_pin, PIN_FUNC_GPIO);
    esp_rom_gpio_connect_out_signal(clk_pin, I2S0I_WS_OUT_IDX, false, false);
    gpio_func_sel((gpio_num_t)data_pin, PIN_FUNC_GPIO);
    gpio_input_enable((gpio_num_t)data_pin);
    esp_rom_gpio_connect_in_signal(data_pin, I2S0I_SD_IN_IDX, false);
    s_clk_pin = clk_pin;
    s_data_pin = data_pin;
}

#endif /* SOC_I2S_SUPPORTS_PDM2PCM */

esp_err_t fos_mic_start(int clk_pin, int data_pin, int pwr_pin)
{
#if !SOC_I2S_SUPPORTS_PDM2PCM
    (void)clk_pin;
    (void)data_pin;
    (void)pwr_pin;
    return ESP_ERR_NOT_SUPPORTED;
#else
    if (s_active) return ESP_ERR_INVALID_STATE;
    if (clk_pin < 0 || data_pin < 0) return ESP_ERR_INVALID_ARG;
    const char *why = fos_config_gpio_pin_reserved(clk_pin);
    if (why == NULL) why = fos_config_gpio_pin_reserved(data_pin);
    if (why == NULL && pwr_pin >= 0) why = fos_config_gpio_pin_reserved(pwr_pin);
    if (why != NULL) {
        ESP_LOGW(TAG, "microphone pins refused: %s", why);
        return ESP_ERR_INVALID_ARG;
    }

    if (pwr_pin >= 0) {
        gpio_config_t io = {
            .pin_bit_mask = 1ULL << pwr_pin,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&io);
        if (err != ESP_OK) return err;
        gpio_set_level((gpio_num_t)pwr_pin, 1);
        vTaskDelay(pdMS_TO_TICKS(MIC_POWER_SETTLE_MS));
    }
    s_pwr_pin = pwr_pin;

    setup_i2s(clk_pin, data_pin);
    esp_err_t err = setup_dma();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "dma: %s", esp_err_to_name(err));
        release_hw();
        if (s_pwr_pin >= 0) {
            gpio_set_level((gpio_num_t)s_pwr_pin, 0);
            s_pwr_pin = -1;
        }
        return err;
    }
    /* Start, in the IDF driver's order: reset the unit and the DMA, clear
     * the FIFO, start the DMA on the first descriptor, start the receiver. */
    i2s_ll_rx_reset(MIC_HW);
    gdma_reset(s_dma);
    i2s_ll_rx_reset_fifo(MIC_HW);
    gdma_start(s_dma, (intptr_t)&s_desc[0]);
    i2s_ll_rx_start(MIC_HW);
    s_active = true;
    return ESP_OK;
#endif
}

esp_err_t fos_mic_read(void *dst, size_t len, size_t *got, uint32_t timeout_ms)
{
    if (got) *got = 0;
#if !SOC_I2S_SUPPORTS_PDM2PCM
    (void)dst;
    (void)len;
    (void)timeout_ms;
    return ESP_ERR_NOT_SUPPORTED;
#else
    if (!s_active) return ESP_ERR_INVALID_STATE;
    uint8_t *out = dst;
    size_t copied = 0;
    while (copied < len) {
        if (s_reading == NULL || s_read_pos >= MIC_DMA_BUF_BYTES) {
            if (xQueueReceive(s_filled, &s_reading, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
                s_reading = NULL;
                break;
            }
            s_read_pos = 0;
        }
        size_t take = MIC_DMA_BUF_BYTES - s_read_pos;
        if (take > len - copied) take = len - copied;
        memcpy(out + copied, s_reading + s_read_pos, take);
        s_read_pos += take;
        copied += take;
    }
    if (got) *got = copied;
    /* A timeout with some bytes is a short read, not a failure. */
    return copied > 0 || len == 0 ? ESP_OK : ESP_ERR_TIMEOUT;
#endif
}

void fos_mic_stop(void)
{
#if SOC_I2S_SUPPORTS_PDM2PCM
    if (s_active) release_hw();
#endif
    if (s_pwr_pin >= 0) {
        gpio_set_level((gpio_num_t)s_pwr_pin, 0);
        s_pwr_pin = -1;
    }
    s_active = false;
}

bool fos_mic_active(void)
{
    return s_active;
}
