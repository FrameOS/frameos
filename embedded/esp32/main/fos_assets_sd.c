#include "fos_assets_sd.h"

#include <stdio.h>
#include <string.h>

#include <stdlib.h>

#include "driver/gpio.h"
#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "soc/soc_caps.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

#include "fos_sd_probe.h"
#include "frameos_nim.h"

static const char *TAG = "fos_assets_sd";

static bool s_mounted = false;
static sdmmc_card_t *s_card = NULL;
static char s_last_error[FOS_ASSETS_SD_ERROR_LEN] = "";
/* Stable machine code for the same failure (string literal, never freed). */
static const char *s_last_error_code = "";
/* The outcome line from the last mount attempt, kept so it can be replayed
 * once log upload is enabled (see fos_assets_sd_log_status). */
static char s_last_log_line[FOS_ASSETS_SD_LOG_LEN] = "";

/* Why the card is not mounted, split into a stable machine code the backend
 * and cloud can key specific guidance off, and the sentence a user needs.
 *
 * The three real-world causes need completely different actions, and
 * esp_vfs_fat_sdspi_mount separates them by return code:
 *
 *   - sdmmc_card_init() runs FIRST. If nothing answers the SD command set the
 *     mount returns that layer's code (ESP_ERR_TIMEOUT / ESP_ERR_NOT_FOUND /
 *     ESP_ERR_INVALID_RESPONSE) => no card, or the pins are wrong.
 *   - Only once the card has initialised does f_mount run, and the only way
 *     its failure reaches us is as a bare ESP_FAIL => the card is physically
 *     fine and talking; FatFs just cannot read the volume on it.
 *   - Bus-level corruption on a card that is present surfaces as
 *     ESP_ERR_INVALID_CRC, which the retry/slower-clock loop already fights.
 *
 * (Caveat: a data-WRITE error deep in the SPI host can also return ESP_FAIL,
 * but card init only reads, so ESP_FAIL here is FR_NO_FILESYSTEM in
 * practice.) */
typedef struct {
    const char *code;   /* stable, machine-readable */
    const char *detail; /* one sentence, user-facing */
} sd_reason_t;

static sd_reason_t mount_reason(esp_err_t err)
{
    switch (err) {
        case ESP_FAIL:
            /* The card is present and healthy — this is a filesystem problem,
             * and by far the most likely one is exFAT. FatFs here is built
             * with FF_FS_EXFAT 0 (hardcoded in IDF's ffconf.h; there is no
             * Kconfig for it), and macOS/Windows format any card over 32 GB
             * as exFAT by default, so "big card straight from a Mac" lands
             * exactly here. A blank card looks identical at this API. */
            /* Detail strings stay 7-bit ASCII: they are copied verbatim into a
             * JSON log line that snprintf may (in principle) truncate, and a
             * cut multi-byte character would make that line invalid UTF-8. */
            return (sd_reason_t){"unreadable_filesystem",
                "card is present but its filesystem is unreadable: this frame reads "
                "FAT16/FAT32, not exFAT, and computers format cards over 32 GB as exFAT "
                "by default. Reformat the card as MS-DOS (FAT32) on a computer (that "
                "erases it, so copy the photos off first), then copy the files back. "
                "The frame changed nothing on the card"};
        case ESP_ERR_TIMEOUT:
        case ESP_ERR_INVALID_RESPONSE:
        case ESP_ERR_NOT_FOUND:
            return (sd_reason_t){"no_card",
                "no card detected: nothing answered on the SD bus. Check that a card is "
                "seated in the slot and that the CS/SCK/MISO/MOSI pins match the wiring"};
        case ESP_ERR_INVALID_CRC:
            return (sd_reason_t){"io_error",
                "card is present but the SD bus is corrupting data: wiring is too long "
                "or too noisy, try a lower assets_sd_freq"};
        case ESP_ERR_NO_MEM:
            return (sd_reason_t){"io_error", "out of memory while mounting"};
        case ESP_ERR_INVALID_STATE:
            return (sd_reason_t){"not_configured",
                "SD assets are disabled, or the mount point is already in use"};
        case ESP_ERR_INVALID_ARG:
            return (sd_reason_t){"not_configured",
                "SD assets are enabled but the pin/path configuration is incomplete"};
        case ESP_ERR_NOT_SUPPORTED:
            return (sd_reason_t){"unsupported",
                "this chip has no spare SPI host for SD assets"};
        default:
            return (sd_reason_t){"io_error", "mount failed"};
    }
}

static void set_last_error(esp_err_t err)
{
    if (err == ESP_OK) {
        s_last_error[0] = '\0';
        s_last_error_code = "";
        return;
    }
    sd_reason_t reason = mount_reason(err);
    s_last_error_code = reason.code;
    snprintf(s_last_error, sizeof(s_last_error), "%s (%s): %s",
             esp_err_to_name(err), reason.code, reason.detail);
}

#if SOC_SPI_PERIPH_NUM >= 3

static char s_mount_point[FOS_ASSETS_PATH_LEN] = "";

static bool valid_pin(int8_t pin)
{
    return pin >= 0 && pin <= 48;
}

static bool valid_config(const fos_config_t *config)
{
    if (!config || !config->assets_sd.enabled) return false;
    return config->assets_path[0] &&
        valid_pin(config->assets_sd.cs) &&
        valid_pin(config->assets_sd.sck) &&
        valid_pin(config->assets_sd.miso) &&
        valid_pin(config->assets_sd.mosi);
}

static void enable_pullup(int8_t pin)
{
    if (!valid_pin(pin)) return;
    gpio_reset_pin((gpio_num_t)pin);
    gpio_set_pull_mode((gpio_num_t)pin, GPIO_PULLUP_ONLY);
}

/* assets_path is admin-settable, so it could carry a quote that would break
 * the JSON line the backend parses. Nothing here needs real escaping — the
 * path is only ever a mount point — so fold the risky bytes to '_'. */
static void json_safe_copy(const char *src, char *out, size_t out_len)
{
    size_t i = 0;
    for (; src[i] && i + 1 < out_len; i++) {
        unsigned char c = (unsigned char)src[i];
        out[i] = (c < 0x20 || c == '"' || c == '\\') ? '_' : (char)c;
    }
    out[i] = '\0';
}

/* One structured line into the frameos log ring (GET /logs, backend webhook,
 * cloud log_batch). CONFIG_LOG_DEFAULT_LEVEL is WARN on the 32MB profile, so
 * ESP_LOGI is compiled out — this ring line is the only remote evidence of
 * why assets are missing. Stays far below FOS_NIM_LOG_MAX_LINE (1536).
 *
 * `probe` is the verdict token from fos_sd_probe.c ("blank_exfat",
 * "exfat_has_files", …) when the blank-card probe ran, else "". It extends the
 * existing reason vocabulary rather than replacing it: `reason` still says why
 * the mount failed, `probe` says what we found when we looked at the raw
 * sectors and therefore why we did or did not format. */
static void log_mount_outcome(const char *action, bool mounted, esp_err_t err,
                              const char *pins, uint32_t freq_khz, int attempts,
                              uint64_t capacity_bytes, const char *probe)
{
    char path[FOS_ASSETS_PATH_LEN];
    json_safe_copy(s_mount_point, path, sizeof(path));
    /* Probe tokens are compile-time literals from fos_sd_probe.c, so they are
     * already JSON-safe; the ternary keeps the field out of the line entirely
     * when no probe ran. */
    char probe_field[64] = "";
    if (probe && probe[0]) {
        snprintf(probe_field, sizeof(probe_field), ",\"probe\":\"%s\"", probe);
    }
    if (mounted) {
        snprintf(s_last_log_line, sizeof(s_last_log_line),
                 "{\"event\":\"assets:sd\",\"source\":\"esp32\",\"action\":\"%s\","
                 "\"mounted\":true,\"path\":\"%s\",\"capacityMB\":%llu,"
                 "\"pins\":\"%s\",\"freqKHz\":%lu,\"attempts\":%d%s}",
                 action, path,
                 (unsigned long long)(capacity_bytes / (1024ULL * 1024ULL)),
                 pins, (unsigned long)freq_khz, attempts, probe_field);
    } else {
        sd_reason_t reason = mount_reason(err);
        snprintf(s_last_log_line, sizeof(s_last_log_line),
                 "{\"event\":\"assets:sd\",\"source\":\"esp32\",\"action\":\"%s\","
                 "\"mounted\":false,\"error\":\"%s\",\"reason\":\"%s\",\"detail\":\"%s\","
                 "\"path\":\"%s\",\"pins\":\"%s\",\"freqKHz\":%lu,\"attempts\":%d%s}",
                 action, esp_err_to_name(err), reason.code, reason.detail,
                 path, pins, (unsigned long)freq_khz, attempts, probe_field);
    }
    frameos_nim_log_hook(s_last_log_line);
}

/* --------------------------------------------------------------------------
 * Blank-card probe
 *
 * esp_vfs_fat_sdspi_mount frees its sdmmc_card_t and detaches the SPI device
 * on every failure path, so by the time we know the mount failed there is no
 * card handle left to read sectors with. We bring up our own on the SPI bus
 * that is still initialised, mirroring exactly what the mount does, read a few
 * sectors, and tear it back down. Read-only from start to finish: nothing in
 * here or in fos_sd_probe.c ever issues a write.
 * ------------------------------------------------------------------------ */

typedef struct {
    sdmmc_card_t *card;
} probe_ctx_t;

static bool probe_read_sectors(void *ctx, uint64_t lba, uint32_t count, uint8_t *dst)
{
    probe_ctx_t *p = (probe_ctx_t *)ctx;
    if (!p || !p->card || lba > SIZE_MAX) return false;
    return sdmmc_read_sectors(p->card, dst, (size_t)lba, (size_t)count) == ESP_OK;
}

/* Returns the verdict; *detail always receives a token fit for the log. Any
 * failure to set the probe up at all is a refusal, never a format. */
static fos_sd_probe_verdict_t sd_probe_blank(const sdmmc_host_t *host_template,
                                             const sdspi_device_config_t *slot_config,
                                             const char **detail)
{
    *detail = "probe_unavailable";
    fos_sd_probe_verdict_t verdict = FOS_SD_PROBE_REFUSE;

    sdmmc_host_t host = *host_template;
    if (host.init && host.init() != ESP_OK) return verdict;

    sdspi_dev_handle_t handle = 0;
    esp_err_t err = sdspi_host_init_device(slot_config, &handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD probe could not attach to the SPI bus: %s", esp_err_to_name(err));
        return verdict;
    }
    host.slot = handle;

    sdmmc_card_t *card = calloc(1, sizeof(sdmmc_card_t));
    /* sdmmc transfers want a DMA-capable, word-aligned buffer. */
    uint8_t *scratch = heap_caps_malloc(FOS_SD_PROBE_SCRATCH_BYTES, MALLOC_CAP_DMA);
    if (card && scratch) {
        err = sdmmc_card_init(&host, card);
        if (err != ESP_OK) {
            *detail = "probe_card_init_failed";
        } else if (card->csd.sector_size != FOS_SD_SECTOR_BYTES) {
            /* Every sector number the probe computes assumes 512-byte sectors. */
            *detail = "probe_sector_size";
        } else {
            probe_ctx_t ctx = {.card = card};
            verdict = fos_sd_probe_run(probe_read_sectors, &ctx,
                                       (uint64_t)card->csd.capacity,
                                       scratch, FOS_SD_PROBE_SCRATCH_BYTES, detail);
        }
    } else {
        *detail = "probe_out_of_memory";
    }

    free(scratch);
    free(card);
    sdspi_host_remove_device(handle);
    return verdict;
}

static void sd_unmount(void)
{
    if (!s_mounted) return;
    esp_vfs_fat_sdcard_unmount(s_mount_point, s_card);
    spi_bus_free(SPI3_HOST);
    s_mounted = false;
    s_card = NULL;
}

/* Mount the card at config->assets_path.
 *
 * `allow_format` is true ONLY for the explicit, user-triggered format action.
 * The boot path must never pass true — see the mount_config comment. */
static esp_err_t sd_mount(const fos_config_t *config, bool allow_format, const char *action)
{
    char pins[FOS_STR_LEN];
    fos_config_format_assets_sd_pins(&config->assets_sd, pins, sizeof(pins));
    if (!valid_config(config)) {
        ESP_LOGW(TAG, "SD assets enabled but config is incomplete: path=%s pins=%s",
                 config->assets_path[0] ? config->assets_path : "(unset)", pins);
        set_last_error(ESP_ERR_INVALID_ARG);
        log_mount_outcome(action, false, ESP_ERR_INVALID_ARG, pins, 0, 0, 0, "");
        return ESP_ERR_INVALID_ARG;
    }
    strlcpy(s_mount_point, config->assets_path, sizeof(s_mount_point));

    enable_pullup(config->assets_sd.cs);
    enable_pullup(config->assets_sd.sck);
    enable_pullup(config->assets_sd.miso);
    enable_pullup(config->assets_sd.mosi);

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = SPI3_HOST;
    if (config->assets_sd.max_freq_khz > 0) {
        host.max_freq_khz = config->assets_sd.max_freq_khz;
    }

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = config->assets_sd.mosi,
        .miso_io_num = config->assets_sd.miso,
        .sclk_io_num = config->assets_sd.sck,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    esp_err_t err = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD SPI bus init failed on SPI3 (%s): %s", pins, esp_err_to_name(err));
        set_last_error(err);
        log_mount_outcome(action, false, err, pins, host.max_freq_khz, 0, 0, "");
        return err;
    }

    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot_config.host_id = host.slot;
    slot_config.gpio_cs = (gpio_num_t)config->assets_sd.cs;

    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        /* NEVER true on the boot path — a failed mount must leave the card
         * exactly as the user handed it to us.
         *
         * The tempting reasoning ("esp_vfs_fat_sdspi_mount only formats on
         * FR_NO_FILESYSTEM, and a good card never reports that") is wrong:
         * FatFs reports *every* volume it cannot parse as FR_NO_FILESYSTEM,
         * and it cannot parse exFAT — FF_FS_EXFAT is hardcoded to 0 in IDF's
         * components/fatfs/src/ffconf.h with no Kconfig to turn it on, so
         * reading exFAT would mean patching a vendored IDF component. Since
         * macOS and Windows format any SD card over 32 GB as exFAT by
         * default, a card full of the user's photos is indistinguishable, at
         * this API, from a blank card. Auto-formatting there erases the
         * photos, silently. Don't — report it instead (see mount_reason).
         *
         * The boot path can still format, but only after reading the raw
         * sectors itself and *proving* the card empty (see the autoformat
         * block below); FatFs's own FR_NO_FILESYSTEM is never enough.
         *
         * Formatting a card the probe refuses stays available as an explicit
         * user action that says out loud that it erases: `sd format` /
         * `usb_api format-sd` on the console, or
         * POST /api/action/format-sd over HTTP. */
        .format_if_mount_failed = allow_format,
        .max_files = 8,
        .allocation_unit_size = 16 * 1024,
    };

    /* Card init over jumper wires can time out on the first probe; retry a
     * few times, then once more at a reduced bus clock before giving up. */
    const int max_attempts = 3;
    int attempts = 0;
    for (int attempt = 1; attempt <= max_attempts; attempt++) {
        attempts = attempt;
        err = esp_vfs_fat_sdspi_mount(s_mount_point, &host, &slot_config, &mount_config, &s_card);
        if (err == ESP_OK) break;
        ESP_LOGW(TAG, "mounting SD assets at %s failed (attempt %d/%d, %s, pins=%s, %lu kHz)",
                 s_mount_point, attempt, max_attempts, esp_err_to_name(err), pins,
                 (unsigned long)host.max_freq_khz);
        s_card = NULL;
        /* ESP_FAIL is "the card talks but has no readable filesystem" — not a
         * flaky link. Neither a retry nor a slower clock changes that answer. */
        if (err == ESP_FAIL) break;
        if (attempt == max_attempts) break;
        if (attempt == max_attempts - 1 && host.max_freq_khz > 10000) {
            host.max_freq_khz = 10000;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }

    /* Auto-format, narrowly. ESP_FAIL means "the card talks but FatFs cannot
     * read a volume on it" — which is a blank card AND every exFAT card, so it
     * is not on its own permission to erase anything. Read the raw sectors and
     * only format if they prove there is nothing to lose. Every uncertain
     * answer, every unexpected value and every read error comes back as
     * FOS_SD_PROBE_REFUSE and we stay unmounted, exactly as before. */
    const char *probe = "";
    if (err == ESP_FAIL && !allow_format && config->assets_sd.autoformat) {
        fos_sd_probe_verdict_t verdict = sd_probe_blank(&host, &slot_config, &probe);
        if (verdict == FOS_SD_PROBE_REFUSE) {
            ESP_LOGW(TAG, "SD auto-format declined [%s] — the card is not provably "
                          "empty, leaving it untouched", probe);
        } else {
            ESP_LOGW(TAG, "SD card probed as provably empty [%s] — formatting", probe);
            action = "autoformat";
            mount_config.format_if_mount_failed = true;
            attempts++;
            err = esp_vfs_fat_sdspi_mount(s_mount_point, &host, &slot_config, &mount_config, &s_card);
            mount_config.format_if_mount_failed = false;
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "SD auto-format failed: %s", esp_err_to_name(err));
                s_card = NULL;
            }
        }
    }

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD assets unavailable [%s] — %s",
                 mount_reason(err).code, mount_reason(err).detail);
        spi_bus_free(host.slot);
        s_card = NULL;
        set_last_error(err);
        log_mount_outcome(action, false, err, pins, host.max_freq_khz, attempts, 0, probe);
        return err;
    }

    s_mounted = true;
    set_last_error(ESP_OK);
    uint64_t capacity = fos_assets_sd_capacity_bytes();
    /* LOG_DEFAULT_LEVEL is WARN on the 32MB profile: ESP_LOGI would vanish. */
    ESP_LOGW(TAG, "SD assets mounted at %s (%llu MB, pins=%s, %lu kHz)",
             s_mount_point,
             (unsigned long long)(capacity / (1024ULL * 1024ULL)),
             pins,
             (unsigned long)host.max_freq_khz);
    log_mount_outcome(action, true, ESP_OK, pins, host.max_freq_khz, attempts, capacity, probe);
    return ESP_OK;
}

#endif /* SOC_SPI_PERIPH_NUM >= 3 */

esp_err_t fos_assets_sd_mount(const fos_config_t *config)
{
    if (s_mounted) return ESP_OK;
    if (!config || !config->assets_sd.enabled) return ESP_OK;

#if SOC_SPI_PERIPH_NUM < 3
    /* SD assets ride a dedicated SPI3 bus so they never contend with the
     * display on SPI2. Chips with a single general-purpose SPI host (the
     * ESP32-C3) have no free bus for it — every C3 preset ships with SD
     * assets off, so only a hand-enabled config can get here. */
    ESP_LOGW(TAG, "SD assets need a second SPI host; not available on this chip");
    set_last_error(ESP_ERR_NOT_SUPPORTED);
    return ESP_ERR_NOT_SUPPORTED;
#else
    return sd_mount(config, false, "mount");
#endif
}

esp_err_t fos_assets_sd_remount(void)
{
#if SOC_SPI_PERIPH_NUM < 3
    set_last_error(ESP_ERR_NOT_SUPPORTED);
    return ESP_ERR_NOT_SUPPORTED;
#else
    const fos_config_t *config = fos_config();
    if (!config || !config->assets_sd.enabled) {
        set_last_error(ESP_ERR_INVALID_STATE);
        return ESP_ERR_INVALID_STATE;
    }
    sd_unmount();
    return sd_mount(config, false, "remount");
#endif
}

esp_err_t fos_assets_sd_format(void)
{
#if SOC_SPI_PERIPH_NUM < 3
    set_last_error(ESP_ERR_NOT_SUPPORTED);
    return ESP_ERR_NOT_SUPPORTED;
#else
    const fos_config_t *config = fos_config();
    if (!config || !config->assets_sd.enabled) {
        set_last_error(ESP_ERR_INVALID_STATE);
        return ESP_ERR_INVALID_STATE;
    }
    /* This ERASES the card. Deliberately narrowed: it only writes a fresh
     * filesystem to a card that carries no volume this firmware can mount —
     * a genuinely blank card, or (careful) an exFAT card whose contents the
     * frame cannot see. A card that mounts is never touched, so this can
     * never quietly wipe a working FAT card.
     *
     * It intentionally bypasses the blank-card probe: reaching here means the
     * user was shown the "this erases the card" warning and asked for it
     * anyway, which has to be able to override a probe refusal. Callers must
     * say "erases" before getting here; boot must never call it. */
    sd_unmount();
    ESP_LOGW(TAG, "explicit SD format requested — this erases an unreadable card");
    return sd_mount(config, true, "format");
#endif
}

bool fos_assets_sd_mounted(void)
{
    return s_mounted;
}

uint64_t fos_assets_sd_capacity_bytes(void)
{
    if (!s_card) return 0;
    return (uint64_t)s_card->csd.capacity * (uint64_t)s_card->csd.sector_size;
}

const char *fos_assets_sd_last_error(void)
{
    return s_last_error;
}

const char *fos_assets_sd_last_error_code(void)
{
    return s_last_error_code;
}

void fos_assets_sd_log_status(void)
{
    /* Replays the boot-time outcome. The mount runs long before Wi-Fi is up
     * and log upload is enabled, so the boot-time emit only reaches the local
     * ring; this replay is what carries it to the backend and the cloud. */
    if (s_last_log_line[0]) {
        frameos_nim_log_hook(s_last_log_line);
    }
}
