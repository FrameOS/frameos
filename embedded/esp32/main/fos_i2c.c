#include "fos_i2c.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

#include "fos_board.h"
#include "fos_config.h"
#include "fos_usb_pads.h"

static const char *TAG = "fos_i2c";

#define I2C_PROBE_TIMEOUT_MS 20
#define I2C_XFER_TIMEOUT_MS 50
/* 100 kHz: every chip here speaks it, and the E-series buses carry 4.7 kΩ
 * pull-ups on the board, so no internal ones are needed; enabling them anyway
 * is harmless on a wired bus and makes a probe of an empty header bus a
 * clean NACK instead of a floating line. */
#define I2C_SPEED_HZ 100000
/* The most a caller waits for the bus mutex. A transaction is 50 ms at
 * worst; a holder that takes longer is stuck, and the caller fails its read
 * instead of hanging its task (a console, a render pass) behind it. */
#define I2C_LOCK_TIMEOUT_MS 500

static const struct {
    const char *name;
    uint8_t address;
} k_chips[FOS_I2C_CHIP_COUNT] = {
    [FOS_I2C_PCF8563] = {"pcf8563", 0x51},
    [FOS_I2C_SHT4X] = {"sht4x", 0x44},
    [FOS_I2C_SY6974B] = {"sy6974b", 0x6b},
    [FOS_I2C_BQ27220] = {"bq27220", 0x55},
    [FOS_I2C_LSM6DS3] = {"lsm6ds3", 0x6a},
    [FOS_I2C_ES8311] = {"es8311", 0x18},
    [FOS_I2C_ES7210] = {"es7210", 0x40},
    [FOS_I2C_AXP2101] = {"axp2101", 0x34},
    [FOS_I2C_TCA9554] = {"tca9554", 0x20},
    [FOS_I2C_QMI8658] = {"qmi8658", 0x6b},
};

/* Two chips FrameOS knows answer at 0x6b: the reTerminal E-series' SY6974B
 * charger and the AMOLED 1.75's QMI8658 IMU, whose WHO_AM_I (register 0)
 * reads 0x05. The charger's register 0 is its input current limit (0x17 out
 * of reset on the BQ2560x map): never 0x05 with a cell's worth of current. A
 * chip that reads the other's answer is not that chip. */
#define QMI8658_WHO_AM_I 0x05

static bool identity_ok(size_t chip, i2c_master_dev_handle_t dev)
{
    if (chip != FOS_I2C_QMI8658 && chip != FOS_I2C_SY6974B) return true;
    uint8_t reg = 0x00, who = 0;
    if (i2c_master_transmit_receive(dev, &reg, 1, &who, 1, I2C_XFER_TIMEOUT_MS) != ESP_OK) return false;
    return (who == QMI8658_WHO_AM_I) == (chip == FOS_I2C_QMI8658);
}

static SemaphoreHandle_t s_lock = NULL;
static i2c_master_bus_handle_t s_buses[FOS_I2C_BUSES_MAX];
static fos_i2c_bus_t s_bus_pins[FOS_I2C_BUSES_MAX];
static uint8_t s_bus_count = 0;
static i2c_master_dev_handle_t s_devices[FOS_I2C_CHIP_COUNT];
static int8_t s_device_bus[FOS_I2C_CHIP_COUNT]; /* which bus answered, -1 = absent */
/* A bus another driver put a device of its own on (fos_i2c_lend_bus): the
 * reTerminal E1003's touch controller shares the clock's bus. */
static bool s_bus_lent[FOS_I2C_BUSES_MAX];

/* GPIO19/20 are the ESP32-S3's USB D-/D+ pads, and the ROM leaves the
 * USB-Serial/JTAG PHY attached to them. The Seeed reTerminal E-series wire
 * exactly those two to their I2C bus (CH340 for USB instead): with the PHY
 * still on the pads the bus answered the first read and then NACKed every
 * write (0x103 on the E1002, 2026-10-25) until a re-init happened to win the
 * pads back. Detach the PHY once, before the bus comes up — and say so, so
 * that the console does not take the pads back under it. */
static void release_usb_pads_if_needed(const fos_i2c_bus_t *bus)
{
    fos_usb_pads_claim(bus->sda, bus->scl);
}

static void teardown_locked(void)
{
    for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
        if (s_devices[c]) {
            i2c_master_bus_rm_device(s_devices[c]);
            s_devices[c] = NULL;
        }
        s_device_bus[c] = -1;
    }
    /* A lent bus stays up, with its device: deleting it would pull the bus
     * out from under the driver that borrowed it. It moves to the front, and
     * the rescan finds it again by its pins. */
    uint8_t kept = 0;
    for (size_t b = 0; b < s_bus_count; b++) {
        if (!s_buses[b]) continue;
        if (s_bus_lent[b]) {
            s_buses[kept] = s_buses[b];
            s_bus_pins[kept] = s_bus_pins[b];
            s_bus_lent[kept] = true;
            kept++;
        } else {
            i2c_del_master_bus(s_buses[b]);
        }
    }
    for (size_t b = kept; b < FOS_I2C_BUSES_MAX; b++) {
        s_buses[b] = NULL;
        s_bus_lent[b] = false;
    }
    s_bus_count = kept;
}

static int find_bus_locked(int sda, int scl, uint8_t below)
{
    for (uint8_t b = 0; b < below; b++) {
        if (s_buses[b] && s_bus_pins[b].sda == sda && s_bus_pins[b].scl == scl) return b;
    }
    return -1;
}

/* Find the chips FrameOS knows on bus `index`. Under s_lock. */
static void probe_bus_locked(i2c_master_bus_handle_t bus, uint8_t index)
{
    for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
        if (s_devices[c]) continue; /* found on an earlier bus */
        if (i2c_master_probe(bus, k_chips[c].address, I2C_PROBE_TIMEOUT_MS) != ESP_OK) continue;
        i2c_device_config_t dev_config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = k_chips[c].address,
            .scl_speed_hz = I2C_SPEED_HZ,
        };
        if (i2c_master_bus_add_device(bus, &dev_config, &s_devices[c]) != ESP_OK) {
            s_devices[c] = NULL;
        } else if (!identity_ok(c, s_devices[c])) {
            i2c_master_bus_rm_device(s_devices[c]);
            s_devices[c] = NULL;
        } else {
            s_device_bus[c] = (int8_t)index;
        }
    }
}

/* One byte to a device with no registers (a coprocessor's command), tried
 * `tries` times 20 ms apart. */
static esp_err_t command_locked(i2c_master_bus_handle_t bus, uint8_t addr, uint8_t byte, int tries)
{
    i2c_device_config_t dev_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = I2C_SPEED_HZ,
    };
    i2c_master_dev_handle_t dev = NULL;
    esp_err_t err = i2c_master_bus_add_device(bus, &dev_config, &dev);
    if (err != ESP_OK) return err;
    while ((err = i2c_master_transmit(dev, &byte, 1, I2C_XFER_TIMEOUT_MS)) != ESP_OK && --tries > 0) {
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    i2c_master_bus_rm_device(dev);
    return err;
}

/* The board's one-byte commands (fos_board_i2c_writes) on its first bus,
 * before anything is probed: a coprocessor that comes up after the ESP32
 * gets each for up to 200 ms. */
static void board_writes_locked(i2c_master_bus_handle_t bus, const char *hardware_preset)
{
    const uint8_t *pairs = NULL;
    size_t n = fos_board_i2c_writes(hardware_preset, &pairs);
    for (size_t i = 0; i < n; i++) command_locked(bus, pairs[2 * i], pairs[2 * i + 1], 10);
}

esp_err_t fos_i2c_command(uint8_t addr, uint8_t byte)
{
    if (!s_lock || s_bus_count == 0) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t err = command_locked(s_buses[0], addr, byte, 3);
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t fos_i2c_init(void)
{
    if (!s_lock) {
        s_lock = xSemaphoreCreateMutex();
        if (!s_lock) return ESP_ERR_NO_MEM;
        for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) s_device_bus[c] = -1;
    }
    const fos_config_t *config = fos_config();
    xSemaphoreTake(s_lock, portMAX_DELAY);
    teardown_locked();
    const uint8_t lent_count = s_bus_count;
    esp_err_t first_err = ESP_OK;
    for (uint8_t i = 0; i < config->i2c_bus_count && i < FOS_I2C_BUSES_MAX; i++) {
        int lent = find_bus_locked(config->i2c_buses[i].sda, config->i2c_buses[i].scl, lent_count);
        if (lent >= 0) {
            probe_bus_locked(s_buses[lent], (uint8_t)lent);
            continue;
        }
        if (s_bus_count >= SOC_I2C_NUM) {
            ESP_LOGW(TAG, "this chip has %d I2C port(s); bus sda%d/scl%d not opened",
                     (int)SOC_I2C_NUM, config->i2c_buses[i].sda, config->i2c_buses[i].scl);
            break;
        }
        const char *why = fos_config_gpio_pin_reserved(config->i2c_buses[i].sda);
        if (why == NULL) why = fos_config_gpio_pin_reserved(config->i2c_buses[i].scl);
        if (why != NULL) {
            ESP_LOGW(TAG, "bus sda%d/scl%d refused: %s", config->i2c_buses[i].sda,
                     config->i2c_buses[i].scl, why);
            continue;
        }
        release_usb_pads_if_needed(&config->i2c_buses[i]);
        i2c_master_bus_config_t bus_config = {
            .i2c_port = -1, /* any free port: the OLED takes port 0 by name */
            .sda_io_num = (gpio_num_t)config->i2c_buses[i].sda,
            .scl_io_num = (gpio_num_t)config->i2c_buses[i].scl,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags = {.enable_internal_pullup = true},
        };
        i2c_master_bus_handle_t bus = NULL;
        esp_err_t err = i2c_new_master_bus(&bus_config, &bus);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "bus sda%d/scl%d: %s", config->i2c_buses[i].sda, config->i2c_buses[i].scl,
                     esp_err_to_name(err));
            if (first_err == ESP_OK) first_err = err;
            continue;
        }
        s_buses[s_bus_count] = bus;
        s_bus_pins[s_bus_count] = config->i2c_buses[i];
        s_bus_lent[s_bus_count] = false;
        if (s_bus_count == 0) board_writes_locked(bus, config->hardware_preset);
        probe_bus_locked(bus, s_bus_count);
        s_bus_count++;
    }
    xSemaphoreGive(s_lock);
    if (config->i2c_bus_count > 0) {
        char summary[160];
        fos_i2c_summary(summary, sizeof(summary));
        /* printf: WARN-only builds show it on the console too. */
        printf("i2c: %s\n", summary);
    }
    return first_err;
}

bool fos_i2c_present(fos_i2c_chip_t chip)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT) return false;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return false;
    bool present = s_devices[chip] != NULL;
    xSemaphoreGive(s_lock);
    return present;
}

/* One transaction, one attempt. On the E1002 the first write to the PCF8563
 * after a boot comes back as an unexpected NACK (ESP_ERR_INVALID_STATE,
 * 0x103) while the next one goes through; neither a bus reset nor re-adding
 * the device cured it on the bench, so the caller that cares (fos_rtc.c)
 * tries again later instead of this layer growing a retry. Under s_lock. */
static esp_err_t transact_locked(fos_i2c_chip_t chip, bool write, const uint8_t *tx, size_t tx_len,
                                 uint8_t *rx, size_t rx_len)
{
    if (!s_devices[chip]) return ESP_ERR_NOT_FOUND;
    return write ? i2c_master_transmit(s_devices[chip], tx, tx_len, I2C_XFER_TIMEOUT_MS)
                 : i2c_master_transmit_receive(s_devices[chip], tx, tx_len, rx, rx_len, I2C_XFER_TIMEOUT_MS);
}

esp_err_t fos_i2c_read(fos_i2c_chip_t chip, uint8_t reg, uint8_t *buf, size_t len)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT || !buf || len == 0) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t err = transact_locked(chip, false, &reg, 1, buf, len);
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t fos_i2c_write(fos_i2c_chip_t chip, uint8_t reg, const uint8_t *buf, size_t len)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT || !buf || len == 0 || len > 15) return ESP_ERR_INVALID_ARG;
    uint8_t frame[16];
    frame[0] = reg;
    memcpy(frame + 1, buf, len);
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t err = transact_locked(chip, true, frame, len + 1, NULL, 0);
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t fos_i2c_command_read(fos_i2c_chip_t chip, uint8_t command, uint32_t wait_ms, uint8_t *buf, size_t len)
{
    if (!s_lock || chip >= FOS_I2C_CHIP_COUNT || !buf || len == 0) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t err = transact_locked(chip, true, &command, 1, NULL, 0);
    if (err == ESP_OK) {
        vTaskDelay(pdMS_TO_TICKS(wait_ms) > 0 ? pdMS_TO_TICKS(wait_ms) : 1);
        err = i2c_master_receive(s_devices[chip], buf, len, I2C_XFER_TIMEOUT_MS);
    }
    xSemaphoreGive(s_lock);
    return err;
}

i2c_master_bus_handle_t fos_i2c_lend_bus(int sda, int scl)
{
    if (!s_lock) return NULL;
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) return NULL;
    int b = find_bus_locked(sda, scl, s_bus_count);
    i2c_master_bus_handle_t bus = NULL;
    if (b >= 0) {
        s_bus_lent[b] = true;
        bus = s_buses[b];
    }
    xSemaphoreGive(s_lock);
    return bus;
}

const char *fos_i2c_chip_name(fos_i2c_chip_t chip)
{
    return chip < FOS_I2C_CHIP_COUNT ? k_chips[chip].name : "?";
}

void fos_i2c_summary(char *out, size_t out_len)
{
    if (out_len == 0) return;
    out[0] = '\0';
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(I2C_LOCK_TIMEOUT_MS)) != pdTRUE) {
        snprintf(out, out_len, s_lock ? "busy" : "none");
        return;
    }
    size_t used = 0;
    for (uint8_t b = 0; b < s_bus_count; b++) {
        int n = snprintf(out + used, out_len - used, "%ssda%d/scl%d:", b ? "; " : "",
                         s_bus_pins[b].sda, s_bus_pins[b].scl);
        if (n < 0 || (size_t)n >= out_len - used) break;
        used += (size_t)n;
        bool any = false;
        for (size_t c = 0; c < FOS_I2C_CHIP_COUNT; c++) {
            if (s_device_bus[c] != (int8_t)b) continue;
            n = snprintf(out + used, out_len - used, " %s", k_chips[c].name);
            if (n < 0 || (size_t)n >= out_len - used) break;
            used += (size_t)n;
            any = true;
        }
        if (!any) {
            n = snprintf(out + used, out_len - used, " (nothing known)");
            if (n < 0 || (size_t)n >= out_len - used) break;
            used += (size_t)n;
        }
    }
    if (s_bus_count == 0) snprintf(out, out_len, "none");
    xSemaphoreGive(s_lock);
}

esp_err_t fos_i2c_expander_input(uint8_t *value)
{
    return fos_i2c_read(FOS_I2C_TCA9554, 0x00, value, 1);
}
