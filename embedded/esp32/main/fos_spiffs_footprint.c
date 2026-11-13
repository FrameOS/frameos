#include "fos_spiffs_footprint.h"

/* spiffs_page_header: obj_id (u16), span_ix (u16), flags (u8), packed. */
#define PAGE_HEADER 5u
/* The object index (header) pages pad that header to 4 bytes. */
#define INDEX_PAGE_HEADER 8u
/* spiffs_page_object_ix_header after the padded header: size (u32) and type
 * (u8), then the name and the metadata. */
#define INDEX_HEADER_FIXED (INDEX_PAGE_HEADER + 4u + 1u)
/* spiffs_page_ix */
#define PAGE_REF 2u

size_t fos_spiffs_pages(size_t bytes, size_t page_bytes, size_t name_len, size_t meta_len)
{
    if (page_bytes <= INDEX_HEADER_FIXED + name_len + meta_len + PAGE_REF) return 0;
    size_t data = page_bytes - PAGE_HEADER;
    size_t data_pages = (bytes + data - 1) / data;
    size_t first_refs = (page_bytes - (INDEX_HEADER_FIXED + name_len + meta_len)) / PAGE_REF;
    size_t more_refs = (page_bytes - INDEX_PAGE_HEADER) / PAGE_REF;
    size_t index_pages = 1;
    if (data_pages > first_refs) index_pages += (data_pages - first_refs + more_refs - 1) / more_refs;
    return data_pages + index_pages;
}

size_t fos_spiffs_footprint(size_t bytes, size_t page_bytes, size_t name_len, size_t meta_len)
{
    return fos_spiffs_pages(bytes, page_bytes, name_len, meta_len) * (page_bytes - PAGE_HEADER);
}
