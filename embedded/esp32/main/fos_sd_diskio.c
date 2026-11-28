/* FatFS's disk driver for the SD card (fos_sd_diskio.h).
 *
 * ESP-IDF's (fatfs/diskio/diskio_sdmmc.c) hands FatFS's buffer to
 * sdmmc_read_sectors / sdmmc_write_sectors, which move a buffer that is not
 * DMA-capable through a 512-byte bounce, ONE SECTOR A COMMAND
 * (sdmmc_cmd.c). FatFS passes the caller's buffer straight down for whole
 * sectors, and on the boards with PSRAM the callers' big buffers are in
 * PSRAM: a cloud upload's 256 KiB chunk, an asset_get's read buffer, a
 * photo's bytes on their way to the decoder. On the bench E1004
 * (2026-11-28) a 256 KiB chunk was 512 single-block writes, each waiting
 * out the card's programming time: 66 s a chunk, a 9 MB photo 40 minutes,
 * where the HTTP upload (internal buffers, multi-block) took 3 s a chunk.
 *
 * So the same driver, but such a buffer goes through an internal DMA buffer
 * of up to FOS_SD_BOUNCE_SECTORS sectors, one multi-block command each.
 * The buffer is allocated per call, like IDF's (FatFS calls this under its
 * volume lock), and a board without the internal memory for it falls back
 * to IDF's own path, sector by sector, as before. */
#include "fos_sd_diskio.h"

#include <string.h>

#include "diskio_impl.h"
#include "diskio_sdmmc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_memory_utils.h"
#include "ff.h"

static const char *TAG = "fos_sd_diskio";

/* 16 sectors (8 KB) a command: the per-command cost (the card's busy time
 * after a write, the command round trips) is paid 16 times less often, and
 * 8 KB of internal RAM is held only for the length of one call. */
#define FOS_SD_BOUNCE_SECTORS 16

static sdmmc_card_t *s_cards[FF_VOLUMES];


static bool direct_ok(const void *buff)
{
    return esp_ptr_dma_capable(buff) && ((uintptr_t)buff % 4) == 0;
}

/* The bounce for `count` sectors, as many as fit (at least one), or NULL. */
static uint8_t *bounce_alloc(const sdmmc_card_t *card, UINT count, UINT *sectors)
{
    UINT want = count < FOS_SD_BOUNCE_SECTORS ? count : FOS_SD_BOUNCE_SECTORS;
    while (want > 0) {
        uint8_t *buf = heap_caps_malloc((size_t)want * card->csd.sector_size,
                                        MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (buf) {
            *sectors = want;
            return buf;
        }
        want /= 2;
    }
    return NULL;
}

static DSTATUS sd_initialize(BYTE pdrv)
{
    return sdmmc_get_status(s_cards[pdrv]) == ESP_OK ? 0 : STA_NOINIT;
}

static DSTATUS sd_status(BYTE pdrv)
{
    /* IDF's leaves the per-call status check off (s_disk_status_check_en):
     * a card gone shows as the read or write that fails. */
    (void)pdrv;
    return 0;
}

static DRESULT sd_read(BYTE pdrv, BYTE *buff, DWORD sector, UINT count)
{
    sdmmc_card_t *card = s_cards[pdrv];
    UINT step = 0;
    uint8_t *bounce = direct_ok(buff) || count == 1 ? NULL : bounce_alloc(card, count, &step);
    if (!bounce) {
        esp_err_t err = sdmmc_read_sectors(card, buff, sector, count);
        if (err != ESP_OK) ESP_LOGE(TAG, "read %lu+%u failed (0x%x)", (unsigned long)sector, count, err);
        return err == ESP_OK ? RES_OK : RES_ERROR;
    }
    const size_t size = card->csd.sector_size;
    DRESULT res = RES_OK;
    for (UINT done = 0; done < count;) {
        UINT n = count - done < step ? count - done : step;
        esp_err_t err = sdmmc_read_sectors(card, bounce, sector + done, n);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "read %lu+%u failed (0x%x)", (unsigned long)(sector + done), n, err);
            res = RES_ERROR;
            break;
        }
        memcpy(buff + (size_t)done * size, bounce, (size_t)n * size);
        done += n;
    }
    heap_caps_free(bounce);
    return res;
}

static DRESULT sd_write(BYTE pdrv, const BYTE *buff, DWORD sector, UINT count)
{
    sdmmc_card_t *card = s_cards[pdrv];
    UINT step = 0;
    uint8_t *bounce = direct_ok(buff) || count == 1 ? NULL : bounce_alloc(card, count, &step);
    if (!bounce) {
        esp_err_t err = sdmmc_write_sectors(card, buff, sector, count);
        if (err != ESP_OK) ESP_LOGE(TAG, "write %lu+%u failed (0x%x)", (unsigned long)sector, count, err);
        return err == ESP_OK ? RES_OK : RES_ERROR;
    }
    const size_t size = card->csd.sector_size;
    DRESULT res = RES_OK;
    for (UINT done = 0; done < count;) {
        UINT n = count - done < step ? count - done : step;
        memcpy(bounce, buff + (size_t)done * size, (size_t)n * size);
        esp_err_t err = sdmmc_write_sectors(card, bounce, sector + done, n);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "write %lu+%u failed (0x%x)", (unsigned long)(sector + done), n, err);
            res = RES_ERROR;
            break;
        }
        done += n;
    }
    heap_caps_free(bounce);
    return res;
}

static DRESULT sd_ioctl(BYTE pdrv, BYTE cmd, void *buff)
{
    sdmmc_card_t *card = s_cards[pdrv];
    switch (cmd) {
        case CTRL_SYNC:
            return RES_OK;
        case GET_SECTOR_COUNT:
            *((DWORD *)buff) = card->csd.capacity;
            return RES_OK;
        case GET_SECTOR_SIZE:
            *((WORD *)buff) = card->csd.sector_size;
            return RES_OK;
#if FF_USE_TRIM
        case CTRL_TRIM: {
            if (sdmmc_can_trim(card) != ESP_OK) return RES_PARERR;
            DWORD start = ((DWORD *)buff)[0];
            DWORD end = ((DWORD *)buff)[1];
            sdmmc_erase_arg_t arg = sdmmc_can_discard(card) == ESP_OK ? SDMMC_DISCARD_ARG : SDMMC_ERASE_ARG;
            return sdmmc_erase_sectors(card, start, end - start + 1, arg) == ESP_OK ? RES_OK : RES_ERROR;
        }
#endif
        default:
            return RES_ERROR;
    }
}

void fos_sd_diskio_install(sdmmc_card_t *card)
{
    if (card == NULL) return;
    BYTE pdrv = ff_diskio_get_pdrv_card(card);
    if (pdrv == 0xFF || pdrv >= FF_VOLUMES) {
        ESP_LOGW(TAG, "no FatFS drive holds the card; keeping IDF's driver");
        return;
    }
    static const ff_diskio_impl_t impl = {
        .init = &sd_initialize,
        .status = &sd_status,
        .read = &sd_read,
        .write = &sd_write,
        .ioctl = &sd_ioctl,
    };
    s_cards[pdrv] = card;
    ff_diskio_register(pdrv, &impl);
}
