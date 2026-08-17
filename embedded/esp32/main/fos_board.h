#ifndef FOS_BOARD_H
#define FOS_BOARD_H

/* What chip and board this firmware is actually running on.
 *
 * The status JSON used to hardcode `"target":"esp32-s3"` and
 * `"module":"Seeed XIAO ESP32-S3 class"`, which was true of the first board
 * FrameOS supported and of nothing since. A C3 thin client reporting itself
 * as an S3 sends anyone reading its log down the wrong path: "S3 with 120 KB
 * free" looks like a broken S3, "C3 with 120 KB free" is a C3 doing exactly
 * what a C3 does. Report the truth instead. */

/* Maps an ESP-IDF CONFIG_IDF_TARGET value ("esp32c3") to the platform
 * spelling FrameOS uses everywhere else ("esp32-c3"). Unknown targets come
 * back verbatim rather than guessed at. Pure string work, no IDF. */
const char *fos_board_target_name(const char *idf_target);

/* The chip this image was built for, in FrameOS platform spelling. */
const char *fos_board_target(void);

/* Human-facing board label: the hardware preset the backend baked into the
 * image (or an NVS override) when there is one, else a chip-derived
 * fallback. Never NULL. */
const char *fos_board_module(const char *hardware_preset);

#endif /* FOS_BOARD_H */
