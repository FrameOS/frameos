#ifndef FOS_FRAMEBUFFER_H
#define FOS_FRAMEBUFFER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The one panel-sized buffer a thin client reuses for every full-frame
 * operation.
 *
 * On a PSRAM board these buffers come out of PSRAM (see fos_mem.h) where
 * there are megabytes to spare and a per-render malloc/free is free of
 * consequence. On a PSRAM-less ESP32-C3 the same call lands on the internal
 * heap, and there it is a different thing entirely: an XTEINK X4 (4.26"
 * 800x480, four-grey) needs 96000 contiguous bytes out of the ~380 KB the
 * chip has, on a heap that Wi-Fi, lwIP and httpd have already carved up. It
 * works on the first boot and stops working the moment anything fragments —
 * "render #1 failed at allocate: out-of-memory" with 120 KB free, because no
 * single free block was big enough.
 *
 * So take the buffer once, at boot, while the heap is still whole, and hand
 * the same pointer to every caller for the life of the process. Peak usage is
 * unchanged (these call sites were always mutually exclusive in practice);
 * what changes is that the allocation can no longer fail later. */

/* Reserve the buffer. Call once at boot, after the panel is known and before
 * the network stack starts. No-op on boards with PSRAM, and a no-op (with a
 * log line saying so) when the reservation would not leave enough internal
 * heap for Wi-Fi and TLS. */
void fos_framebuffer_reserve(size_t len);

/* Borrow a panel-sized buffer: the reservation when it fits and is not
 * already lent out, otherwise a fresh allocation, otherwise NULL. Pair every
 * non-NULL return with fos_framebuffer_release(). */
uint8_t *fos_framebuffer_acquire(size_t len);

/* Hand a buffer back. Anything that is not the reservation is freed. NULL is
 * accepted and ignored. */
void fos_framebuffer_release(uint8_t *buf);

/* Bytes held by the boot-time reservation, 0 when there is none. Reported in
 * the status JSON so "why did this render fail" is answerable from a log. */
size_t fos_framebuffer_reserved_bytes(void);

/* Reservation policy, split out so the host tests can pin it: reserve only on
 * PSRAM-less boards, only when the buffer fits, and only when enough internal
 * heap survives it for the network stack. */
bool fos_framebuffer_should_reserve(size_t len, size_t psram_total, size_t internal_free);

/* Internal heap that must remain after the reservation. Wi-Fi plus lwIP plus
 * an httpd instance sit around 60-80 KB on the C3; this leaves room for that
 * and a TLS handshake on top. A panel that cannot clear this bar keeps the
 * old per-render allocation — worse, but not "the frame never joins Wi-Fi". */
#define FOS_FRAMEBUFFER_MIN_HEAP_AFTER_RESERVE (96u * 1024u)

#endif /* FOS_FRAMEBUFFER_H */
