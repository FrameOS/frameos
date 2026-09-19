// USB CDC console: the provisioning surface the ESP32 firmware has on its
// serial port, in both of its dialects —
//   - for people: status / set <key> <value> / wifi / wifi-scan / render /
//     logs / buttons / restart / bootsel / factory-reset
//   - for the browser: `usb_api <command>`, the framed protocol the FrameOS
//     frontend speaks over WebSerial (frontend/src/models/embeddedUsbLogsModel.ts):
//       __FRAMEOS_USB_OK__ <cmd>
//       __FRAMEOS_USB_ERROR__ <cmd> <CODE> <message>
//       __FRAMEOS_USB_BEGIN__ <cmd> <len> text\n<payload>\n__FRAMEOS_USB_END__ <cmd>
//     so "Connect over USB" in the frame's deploy panel provisions a Pico the
//     same way it provisions an ESP32.
#ifndef PK_CONSOLE_H
#define PK_CONSOLE_H

#include <stdbool.h>
#include <stdint.h>

// Reads and runs whatever complete lines have arrived. Called from pk_poll().
void pk_console_poll(void);
// True once per `render` command since the last call.
bool pk_console_take_render_request(void);
// ms since boot of the last console line; 0 = none yet. Somebody typing at
// the console (or a browser provisioning over USB) holds off the power cut.
uint32_t pk_console_last_activity_ms(void);
// The log ring's console sink.
void pk_console_print_line(const char *line);

#endif // PK_CONSOLE_H
