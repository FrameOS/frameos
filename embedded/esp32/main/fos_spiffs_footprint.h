#pragma once

/* What a file of `bytes` costs a SPIFFS partition, in the units its own
 * accounting uses (esp_spiffs_info's total and used): every page the file
 * allocates, data and index alike, counted at the data a page carries
 * (`page_bytes` - 5). A scene's footprint, the scenes' sum and the partition's
 * used / total then add up the way the partition fills (fos_scenes.c reports
 * them to the control planes).
 *
 * The layout is IDF's SPIFFS (components/spiffs/spiffs/src/spiffs_nucleus.h,
 * packed structs, SPIFFS_ALIGNED_OBJECT_INDEX_TABLES 0): a 5-byte header on
 * each page; the object index header page (a file's first page, always
 * there) lists its first (page - 49) / 2 data pages, with a 32-byte name and
 * 4 bytes of metadata (CONFIG_SPIFFS_OBJ_NAME_LEN, CONFIG_SPIFFS_META_LENGTH);
 * every further index page lists (page - 8) / 2. Host-tested against that
 * SPIFFS itself (main/tests/test_fos_spiffs_gc.c). Pure: no IDF. */

#include <stddef.h>

size_t fos_spiffs_footprint(size_t bytes, size_t page_bytes, size_t name_len, size_t meta_len);

/* The pages behind it (the footprint / (page_bytes - 5)). */
size_t fos_spiffs_pages(size_t bytes, size_t page_bytes, size_t name_len, size_t meta_len);
