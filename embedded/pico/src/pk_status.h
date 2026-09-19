// The device status document: `usb_api status` over USB and `GET /status`
// over HTTP return the same JSON, in the shape the ESP32 firmware reports
// (fos_http.c fos_http_status_json) so the browser's USB flow reads either.
// Never contains a secret: no Wi-Fi password, API key or device login.
#ifndef PK_STATUS_H
#define PK_STATUS_H

#include <stddef.h>

#define PK_STATUS_JSON_MAX 2048

// Returns the length written, or 0 when `cap` is too small.
size_t pk_status_json(char *dst, size_t cap);

#endif // PK_STATUS_H
