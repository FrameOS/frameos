# Local network access

On a cloud-managed frame, scenes may not reach addresses on the frame's own
network (a Home Assistant at `homeassistant.local:8123`, a NAS, a camera,
anything at `192.168.x.x`) unless the frame's **local network access** is on.
The scenes were installed by the cloud, and the frame sits inside the owner's
LAN: without the block, a compromised account or a malicious store scene is an
SSRF pivot onto the router and every device that trusts the wire. The owner
turns it on in the frame settings, with a code the frame draws on its panel.

Standalone frames and frames managed by a self-hosted backend have no such
block. They run their owner's own scenes next to the owner's own services, and
what they may reach is the network's call. The switch is not a permission an
app or a scene asks for either (weighed and dropped on 2026-10-17: scenes nest
and copy apps, and no rule can tell from a hostname which local device a scene
should reach).

The switch is one extra layer, not the security boundary. Devices the frame
should never reach belong on a different network or VLAN.

## What is blocked, and when

The block is armed while the frame is cloud-managed, or still runs scenes the
cloud pushed after losing the link (the device stamps who installed its scenes:
`"source": "cloud"` in `state/uploaded.json`, a top-level `"source"` in the
ESP32's `/state/scene-index.json`), and local network access is off. Pi:
`refreshLocalNetworkPolicy` in `frameos/cloud/hub_client.nim`, applied before
the first render. ESP32: `apply_network_policy` in `fos_cloud.c`.

It refuses a scene's request when the target resolves to a private or local
address: loopback (`127/8`, `::1`), RFC1918 (`10/8`, `172.16/12`,
`192.168/16`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`),
`0.0.0.0/8`, broadcast and multicast, IPv6 ULA, and IPv4 wrapped in IPv6. The
check is on the resolved address, every redirect hop is checked again, and the
connect goes to the address that was checked: the Pi's client connects by
address, and the ESP32 pins the connect through lwIP's resolve hook
(`fos_netguard_pin_t`), so a DNS-rebinding name that answers public and then
private cannot slip through. Apps that hand a URL to a child process (the
screenshot and camera apps) pass the same check and are pinned to the checked
address (`frameos/spawn_guard.nim`). Pi: `isPrivateNetworkAddress` /
`enforceLocalNetworkPolicy` in `frameos/utils/http_client.nim`. ESP32:
`fos_netguard.c`, enforced in `frameos_nim_glue.c`. Keep the two classifiers
in step.

The provider's own API endpoint stays reachable by exact `host:port`, so a
development provider on the LAN works.

A refused request fails the node with

```
Local network access is off for this frame, so homeassistant.local (192.168.1.5) cannot be reached. Turn on local network access in the frame settings.
```

The prefix `Local network access is off for this frame` is what the SPA's logs
panel matches to offer a "Turn on local network access" link. A name that does
not resolve is not a block; it fails as `could not resolve <host>`.

## Turning it on: the code on the panel

Turning local network access on needs someone in front of the frame:

1. The frame settings' "Local network access" section on FrameOS Cloud asks
   the frame for a code (on a Pi, the frame's admin API can too).
2. The frame draws a six-digit code on its panel, labeled "Local network access
   code".
3. The person types it into the same page, which sends it to the frame.
4. The frame checks it, turns local network access on, and repaints without
   the code.

The code is six uniform digits from the device's RNG, compared in constant
time, single use, good for 300 seconds and five tries. Across codes the frame
takes at most ten wrong ones an hour; after that both a new code and a typed
one answer `rate_limited` until the hour is up, so asking for code after code
cannot become a brute force. The count outlives a runtime restart or a reboot
(the state file on the Pi, RTC memory on the ESP32), since the cloud could send
those. It is never in an API response, a log line or a command listing. It is
drawn onto the panel only and never leaves the frame as an image:

- Pi: a white band across the middle with the label and the digits in black,
  drawn after the render is stored, so `image_get`, scene snapshots and
  `GET /image` (which then skips the driver's own PNG, the one e-ink drivers
  build from what they last sent to the panel) show the scene without it, and
  the `http.upload` driver gets the image without it.
- ESP32: drawn into the packed buffer just before the blit and taken out again
  before the snapshot that `/image`, `image_get` and the image push all read.

Any end of a challenge (the right code, the fifth wrong one, expiry, a new
challenge, local network access turned off) repaints the panel, so the code
does not stay up for the next person walking past. On the Pi the runner's
sleep loop compares the text it last drew with the one it should show and
repaints when they differ; on the ESP32 a generation number does the same. A
battery ESP32 stays awake while a code is up. A frame whose output is not a
physical panel (`web_only`, `http.upload`) has nowhere to show a code and
answers `no_panel`, so local network access cannot be turned on there.

The Pi's setup hotspot uses the same overlay for its own code (the one
`POST /setup` asks for before it changes anything but Wi-Fi,
`frameos/src/frameos/setup_gate.nim`): one line along the bottom of the panel,
in the strip the hotspot scene leaves free, and only while no local network
access code is up.

Turning it **off** needs no code, and clears a code that is showing. On an
ESP32 the USB console's `set allow_local_network 1` turns it on directly: the
cable is physical presence.

## Where the value lives

| | Truth | What the cloud reads |
| --- | --- | --- |
| Pi / Linux | `state/local_access.json` `allowLocalNetworkAccess` (`frameos/local_access.nim`), never written to `frame.json`; a `frame.json` `network.allowLocalNetworkAccess: true` from before the ceremony still counts while the state file has no value | `hardware.lanAccess` in hello and every `state` |
| ESP32 | NVS `allow_lan` (`fos_config.c`), off when absent | `hardware.lanAccess` in hello and every `state` |
| FrameOS Cloud | | `frames.hardware.lanAccess`, exposed as `lan_access` on the frame (`null` = firmware too old to report it) |

A cloud frame is off until someone turns it on, new or old: nothing here
changes what an existing frame does.

## Routes and verbs

FrameOS Cloud (the SPA calls these):

- `POST /api/frames/{id}/lan_access/challenge` -> `{status: "shown",
  expires_in_seconds}` or `{status: "queued"}` (the frame did not answer within
  the wait, e.g. it is asleep; the code appears when it wakes). Errors
  `{detail, error}`: `no_panel`, `rate_limited`, `challenge_failed`,
  `unsupported` (firmware too old), `timeout`, `unreachable`.
- `POST /api/frames/{id}/lan_access` `{enabled, code?}` -> `{status:
  "applied", lan_access}` or `{status: "queued"}`. Errors carry the device's
  token.

They queue two device verbs (`docs/cloud-frames-contract.json`):

- `lan_access_challenge` `{}` -> ack, or `no_panel`, `rate_limited`,
  `challenge_failed`.
- `lan_access_set` `{enabled, code?}` -> ack, or `invalid_lan_access`,
  `code_required`, `invalid_code`, `code_expired`, `too_many_attempts`,
  `rate_limited`, `persist_failed`. The device sends a fresh `state` when the
  value changes, whoever changed it.

The Pi's own admin API, with an admin session: `GET /api/network/local-access`,
`POST /api/network/local-access/challenge` `{scope?}`,
`POST /api/network/local-access` `{enabled, code?, scope?}`. `scope:
"shellApps"` is the same ceremony for running Chromium unsandboxed as root.

`set_settings` never carries local network access
(`docs/cloud-frames-fixtures.json` pins it), and the bulk settings save on the
frame ignores it.
