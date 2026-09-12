# Native HTTPS on Linux frames (Caddy replaced)

Status: implemented 2026-09-12 (this PR), bench pending (see "Bench").

## What changed

Every Linux frame — Raspberry Pi OS and the three Buildroot images alike —
serves HTTPS from inside the runtime's own HTTP server. There is no Caddy
process any more, neither for the API (`tls_proxy.nim`, deleted) nor for the
hotspot portal (`setup_proxy.nim`, deleted). ESP32 firmware already served
HTTPS natively (`httpd_ssl_start`); Linux frames now match.

- **`FrameOS/mummy` fork** (pinned by commit in `frameos.nimble`, as pixie):
  TLS listeners with OpenSSL inside the epoll loop, `newTlsConfig(certPem,
  keyPem)` loading the material from memory (the private key never touches
  the file system; Caddy needed `frameos-tls-key.pem` on disk),
  `addListener`/`removeListener` from any thread while serving, and
  `Request.secure`. Everything TLS is under `when defined(ssl)`; FrameOS
  builds with `-d:ssl` on every Linux target already.
- **Runtime.** `server/listeners.nim` decides the sockets from the config
  alone (`planListeners`): plain `framePort` on `0.0.0.0` (on `127.0.0.1`
  with `exposeOnlyPort`, on `bindHost` when set) plus TLS on
  `httpsProxy.port` (8443) when `enable` and both `serverCert`/`serverKey`
  are present — otherwise `tls:default_cert` is logged and the frame stays
  plain, as before. A certificate the runtime cannot load or a port it
  cannot bind logs `tls:config_error` / `tls:start_error` and HTTPS stays
  off; the plain listener failing is fatal, as it always was. mummy's own
  log lines reach the frame logger (`http:error`, `http:info`; `http:debug`
  with the per-handshake timing only when `debug` is on).
- **Hotspot.** `server/hotspot_listener.nim`: when the plain listener is not
  on every interface, `finishStartedHotspot` adds a plain listener on
  `10.42.0.1:<first free port from 8000>` (every interface when that address
  is not up yet, which is what the Caddy proxy always bound) and `stopAp`
  removes it. `hotspotSetupPort` reads that port for the QR code and the
  captive-portal redirect.
- **`Request.secure`** feeds the same-origin guard (`origin.nim`, the Host
  header's default port), the `Secure` cookie flag (`auth.nim`) and the
  cloud link's recorded origin (`cloud_api_routes.nim`) alongside
  `X-Forwarded-Proto`, so an owner's own reverse proxy keeps working.
- **Ports below 1024 as uid 990**: `frameos.service.unprivileged` carries
  `CAP_NET_BIND_SERVICE` next to `CAP_SYS_TTY_CONFIG`. The defaults
  (8787/8443) need nothing.
- **Certificate changes** through a backend deploy keep today's behaviour:
  `tls_settings_changed` makes the deploy restart the runtime.
- **Changes saved on the device** (the frame's own settings page, or a
  backend push to a shell-less card over `POST /api/frames/1`) are applied
  without a restart: `server/listener_control.nim` binds the listeners the
  new config wants before frame.json is written — a port that cannot be
  bound or a certificate that cannot be loaded refuses the save with a 409
  and leaves the old sockets and config alone — then removes the ones no
  longer wanted (accepted connections are unaffected; the response to that
  very save still goes out). The response's `apply.listeners` is what the
  admin page follows to the new port or scheme (docs/api-triality.md,
  "On-device save side effects").
- Nothing changes for `frameosEmbedded` / `frameosWasm` (mummy is not
  compiled there).

## Backend, frontend, deploy

- The three Buildroot gates from commit bde54b2f are gone: the force-off in
  `ensure_buildroot_frame_defaults`, the 400 in `api_frame_update_endpoint`,
  the disabled switch in `HttpsProxySection`. A Buildroot frame keeps the
  HTTPS setting it is given, and a new one gets HTTPS on by default like
  every other frame.
- The `caddy` apt package is no longer planned (`frame_deploy_workflow.py`)
  or installed (`frameos-setup.sh`, `frame_bootstrap.py`).
- **Upgrades from a Caddy-era release.** A Pi set up before this had the
  `caddy` package, whose own `caddy.service` was disabled at install and on
  every full deploy that found it enabled. That probe is now version-gated:
  `frame_may_still_run_caddy(previous_frameos_version)` — the deploy
  baseline's `frameos_version`, which the device itself keeps current
  (`remember_device_reported_frameos_version`) — is true only for an unknown
  version or one at or below `LAST_CADDY_FRAMEOS_VERSION = "2026.9.13"`, the
  last release that shipped Caddy. So the first full deploy that takes a
  frame past 2026.9.13 disables a leftover `caddy.service`; a frame already
  reporting something newer is never asked again. The setup scripts keep
  their `systemctl disable --now caddy.service` line for one release, then
  both go.
- Copy: "HTTPS proxy via Caddy" → "HTTPS API", the section is "HTTPS" on
  every platform; `docs/api-triality.md` is unchanged (the `https_proxy`
  shape stays, it is the API's name for the setting).
- No base image rebuild: OpenSSL (3.5.6, `libssl.so.3`) is already in every
  Buildroot image and the runtime linked it before this change
  (`hub_client` wss, `http_client`, `logger`).

## Why native, not Caddy in Buildroot

- Caddy in the Buildroot images needs the Go host toolchain in the base
  build, a ~40 MB binary and 30–50 MB RSS next to the runtime on a 512 MB
  Zero, base rebuilds for all three platforms, and stays a second process
  with its own monitor thread. It would work on ARMv6 (`GOARM=6`), but
  everything above applies twice as hard there.
- An in-process byte-pump terminator (`std/net` `wrapConnectedSocket`, two
  threads per connection to `127.0.0.1:8787`) is half the code, but the
  loopback hop stays, the server cannot tell TLS from plain
  (`X-Forwarded-Proto` would have to be forged into the stream), and the
  hotspot proxy remains a separate thing.
- stunnel / nginx / lighttpd from Buildroot: the same second-process shape,
  more packages, configuration files on a read-only rootfs.
- The server key is P-256 (`generate_frame_tls_material`), so handshakes
  are cheap even on the ARM1176 in a Zero W; the fork's test log shows
  0–1 ms on a laptop.

## Tests

- Fork: `nim c -r -d:ssl tests/test_tls.nim` — GET/POST, plain and TLS side
  by side, a 4 MB response (partial `SSL_write`), keep-alive, WebSocket
  over TLS, a client stalled mid-handshake, plain text on the TLS port,
  listeners added and removed while serving. The upstream suite passes
  with and without `-d:ssl`.
- Runtime: `server/tests/test_listeners.nim` (planning),
  `test_hotspot_listener.nim` and `test_tls_listener.nim` (a TLS listener
  next to the harness's plain one, through the real router: same routes on
  both, `Secure` cookie without a proxy header, the origin guard's 443
  default, a 200 KB POST, removal while serving).
- Backend: `test_frame_may_still_run_caddy`,
  `test_post_deploy_plan_probes_caddy_only_for_caddy_era_frames`,
  `test_api_frame_update_buildroot_keeps_https_proxy`.

## Bench (to do after merge)

- uus2w (`raspberry-pi-64`, uid 990) and Cloud-5: enable HTTPS from the
  backend, expect the admin page on `https://<ip>:8443` with the frame CA
  imported, backend calls over https, WebSocket log stream over wss,
  `exposeOnlyPort` hides 8787, hotspot portal still answers on
  `http://10.42.0.1:<port>`.
- Cloud-W (`raspberry-pi-32`, ARMv6, root): same, plus handshake time in
  the log with `debug` on (expect tens of ms with P-256).
- From the frame's own settings page (standalone, `http://<ip>:8787/frames/1/settings`):
  turn HTTPS on with a generated certificate → the page moves itself to
  `https://<ip>:8443` (browser interstitial once); change the port → it
  follows; tick "expose only the HTTPS port" → plain HTTP is loopback-only
  and the page lands on HTTPS; turn HTTPS off from the https page → back
  on `http://<ip>:8787`, login again (the Secure cookie does not cross).
  A port already in use must be refused with the reason and nothing saved.
- One Raspbian Pi upgraded from 2026.9.13: deploy, confirm the plan disables
  `caddy.service`, that Caddy is neither installed fresh nor running, and
  HTTPS still works. Deploy again: no Caddy probe in the plan.
