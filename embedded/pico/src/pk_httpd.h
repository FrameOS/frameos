// The device's own HTTP server (port 80, lwIP raw TCP, no TLS listener).
//
// Two jobs. In setup-hotspot mode it is the captive portal: every probe URL
// redirects to the setup page, and the page's form provisions Wi-Fi and the
// backend link. On the LAN it is the frame API the backend talks to — the
// same paths the ESP32 serves (fos_http.c), minus everything that needs an
// on-device renderer:
//
//   GET  /            setup + status page
//   GET  /ping        "pong" (open)
//   GET  /status      the status JSON (pk_status.h)
//   GET  /logs        the log ring, "<epoch|-> line" per entry
//   GET  /image       what the panel shows, as a BMP (buffered builds)
//   POST /api/setup   the setup form
//   POST /api/action/render | /api/action/restart | /api/action/reboot
//   POST /event/<name>, /reload   any event re-renders: the scene state the
//                     event changed lives on the backend, which renders it
//
// Access (the ESP32's rule): a hotspot client is already past the WPA2
// passphrase; on the LAN a request needs `Authorization: Bearer <api_key>`
// (what the backend sends) or the device login (`Basic`), and only /ping and
// the portal probes are open.
//
// Handlers run inside lwIP callbacks, so they never block: anything slow is
// left as an action for the main loop.
#ifndef PK_HTTPD_H
#define PK_HTTPD_H

#include <stdbool.h>

typedef enum {
    PK_HTTPD_ACTION_NONE = 0,
    PK_HTTPD_ACTION_RENDER,
    PK_HTTPD_ACTION_RESTART, // also after a saved setup form
} pk_httpd_action_t;

bool pk_httpd_start(void);
// The action a request asked for since the last call (the strongest wins).
pk_httpd_action_t pk_httpd_take_action(void);

#endif // PK_HTTPD_H
