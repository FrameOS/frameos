# LAN access

Every frame has one switch, **LAN access**, that decides whether its scenes may
reach addresses on the frame's own network: a Home Assistant at
`homeassistant.local:8123`, a NAS, a camera, anything at `192.168.x.x`. It is a
frame setting, chosen when the frame is created and changed later in the frame
settings. It is not a permission an app or a scene asks for (that was weighed
and dropped on 2026-10-17: scenes nest and copy apps, and no rule can tell from
a hostname which local device a scene should reach).

The switch is one extra layer, not the security boundary. Devices the frame
should never reach belong on a different network or VLAN; the router decides
what the frame can talk to, and a frame with LAN access on can reach whatever
the router lets it.

## What "off" blocks

With LAN access off, the frame's HTTP client refuses a scene's request when the
target resolves to a private or local address: loopback (`127/8`, `::1`),
RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`,
`fe80::/10`), CGNAT (`100.64/10`), `0.0.0.0/8`, broadcast and multicast, IPv6
ULA, and IPv4 wrapped in IPv6. The check is on the resolved address, so a DNS
name that answers with a router address is refused too, and every redirect hop
is checked again. Apps that hand a URL to a child process (the screenshot and
camera apps) pass the same check first and are pinned to the checked address
(`frameos/spawn_guard.nim`). Pi: `isPrivateNetworkAddress` /
`enforceLocalNetworkPolicy` in `frameos/utils/http_client.nim`. ESP32:
`fos_netguard.c`, enforced in `frameos_nim_glue.c`. Keep the two classifiers
in step.

The frame's own control planes stay reachable by exact `host:port` whatever
the switch says: the FrameOS Cloud endpoint it is linked to, and the
self-hosted backend's `serverHost:serverPort` (`backend_url` on an ESP32). So
logs, the image push and photo album share links from a backend on the LAN keep
working. The frame's own traffic to them (logs, OTA, the hub socket) never went
through the scene policy anyway.

A refused request fails the node with

```
LAN access is off for this frame, so homeassistant.local (192.168.1.5) cannot be reached. Turn on LAN access in the frame settings.
```

The prefix `LAN access is off for this frame` is what the SPA's logs panel
matches to offer a "Turn on LAN access" link. A name that does not resolve is
not a block; it fails as `could not resolve <host>`.

Until this change the deny applied only to cloud-managed frames (and frames
still running scenes the cloud pushed). Now the switch alone decides, on every
frame and on both control planes.

## Choosing it at creation

No code is needed when the value is chosen while the frame is set up. Every
add-frame form shows the switch next to the Wi-Fi fields, off by default:

| Where | How the value reaches the device |
| --- | --- |
| Backend, Add frame (SD card, ESP32, SSH, install script) | `frame.lan_access` column; `get_frame_json` writes it as frame.json `network.lanAccess` (the SD card's `frameos-setup.json` is that frame.json), the ESP32 provisioning plan as `set allow_local_network 0/1` |
| Cloud, SD card image | `lan_access=0/1` in the card's `frameos-cloud.txt`; the first-boot shell (`setup_json_reset.py`) writes `state/local_access.json` before the runtime starts |
| Cloud, ESP32 over USB | `set allow_local_network 0/1` on the console before the Wi-Fi command |
| Cloud, install script | `lan_access` on the claim code (`frame_enrollment_tokens.lan_access`); enrollment queues `lan_access_set {enabled: false}` when it was left off, since off needs no code |

frame.json `network.lanAccess` is a seed, read once: when the runtime starts
and `state/local_access.json` has no value yet, it stores `network.lanAccess`
if frame.json has it, and `true` otherwise. After that frame.json is never
consulted for this, so a later deploy cannot turn it on. (The older frame.json
key `network.allowLocalNetworkAccess` is not a seed: settings saves wrote
`false` into many files without anyone choosing it.)

## Turning it on later: the code on the panel

Turning LAN access on for a frame that has it off needs someone in front of the
frame:

1. The frame settings' "LAN access" switch (backend, FrameOS Cloud, or the
   frame's own admin page) asks the frame for a code.
2. The frame draws a six-digit code on its panel, labeled "LAN access code".
3. The person types it into the same page, which sends it to the frame.
4. The frame checks it, turns LAN access on, and repaints without the code.

The code is six uniform digits from the device's RNG, compared in constant
time, single use, good for 300 seconds and five tries. Across codes the frame
takes at most ten wrong ones an hour; after that both a new code and a typed
one answer `rate_limited` until the hour is up, so asking for code after code
cannot become a brute force. The count outlives a runtime restart or a reboot
(the state file on the Pi, RTC memory on the ESP32), since the same control
plane could send those. It is never in an API response, a log line or a
command listing. It is drawn onto the panel only and
never leaves the frame as an image:

- Pi: a white band across the middle with the label and the digits in black,
  drawn after the render is stored, so `image_get`, scene snapshots and
  `GET /image` (which then skips the driver's own PNG, the one e-ink drivers
  build from what they last sent to the panel) show the scene without it, and
  the `http.upload` driver gets the image without it.
- ESP32: drawn into the packed buffer just before the blit and taken out again
  before the snapshot that `/image`, `image_get` and the BMP push to the
  backend all read.

Any end of a challenge (the right code, the fifth wrong one, expiry, a new
challenge, LAN access turned off) repaints the panel, so the code does not
stay up for the next person walking past. On the Pi the runner's sleep loop
compares the text it last drew with the one it should show and repaints when
they differ; on the ESP32 a generation number does the same. A battery ESP32 stays awake while a code is up. A frame
whose output is not a physical panel (`web_only`, `http.upload`, virtual
frames) has nowhere to show a code and answers `no_panel`: choose LAN access
when setting such a frame up.

Turning it **off** needs no code; any control plane, token or admin page that
may manage the frame can do it, and it clears a code that is showing. On an ESP32 the USB console's
`set allow_local_network 1` turns it on directly: the cable is physical
presence.

## Where the value lives

| | Truth | Mirror the UI reads |
| --- | --- | --- |
| Pi / Linux | `state/local_access.json` `allowLocalNetworkAccess` (`frameos/local_access.nim`); never `frame.json`, which a deploy overwrites | device `GET /api/frames/1` top-level `lan_access`; the hub's `hardware.lanAccess` |
| ESP32 | NVS `lan_access` (`fos_config.c`; the older `allow_lan` is ignored) | hello/state `hardware.lanAccess`; `lan_access` in every backend command ack's state fields |
| Backend | | `frame.lan_access`, updated when a toggle is applied and from ESP32 acks |
| FrameOS Cloud | | `frames.hardware.lanAccess`, exposed as `lan_access` on the frame (`null` = firmware too old to report it) |

A frame with no value stored anywhere predates this switch and has LAN access
**on**: the backend migration sets `lan_access = true` on every existing frame,
the Pi runtime seeds `true` when frame.json has no `network.lanAccess`, and an
ESP32 without the `lan_access` NVS key reads as on. No frame that reached its
LAN before loses it. The one exception is a frame the backend renders itself
(a virtual frame, a Pico thin client): its scenes ran on the backend's own
network under the old `network.allowLocalNetworkAccess`, off unless someone set
it, so the migration keeps that value rather than handing them the backend's
LAN. Such a frame has no panel for a code, so on is refused there and off is
applied to the row the renderer reads.

## Routes and verbs

Control planes (backend and cloud, the same paths and shapes; the SPA calls
them on both):

- `POST /api/frames/{id}/lan_access/challenge` -> `{status: "shown",
  expires_in_seconds}` or `{status: "queued"}` (the frame did not answer within
  the wait, e.g. it is asleep; the code appears when it wakes). Errors
  `{detail, error}`: `no_panel`, `rate_limited`, `challenge_failed`,
  `unsupported` (firmware too old), `timeout`, `unreachable`.
- `POST /api/frames/{id}/lan_access` `{enabled, code?}` -> `{status:
  "applied", lan_access}` or `{status: "queued"}`. Errors carry the device's
  token.

The backend relays a Linux frame's request to its admin API with the
serverApiKey bearer, and queues an ESP32's on its HTTP command queue. The cloud
queues both device verbs (`docs/cloud-frames-contract.json`):

- `lan_access_challenge` `{}` -> ack, or `no_panel`, `rate_limited`,
  `challenge_failed`.
- `lan_access_set` `{enabled, code?}` -> ack, or
  `invalid_lan_access`, `code_required`, `invalid_code`, `code_expired`,
  `too_many_attempts`, `rate_limited`, `persist_failed`. The device sends a
  fresh `state` when the value changes, whoever changed it.

The Pi's own admin API (used by the frame's admin page and by the backend):
`GET /api/network/local-access`, `POST /api/network/local-access/challenge`
`{scope?}`, `POST /api/network/local-access` `{enabled, code?, scope?}`, with an
admin session or the backend's serverApiKey bearer. `scope: "shellApps"` is
the same ceremony for running Chromium unsandboxed as root.

`set_settings` never carries LAN access (`docs/cloud-frames-fixtures.json`
pins it), and the bulk settings save on the frame ignores it.
