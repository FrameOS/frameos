# The flasher: flash.frameos.net

A page for anyone with an ESP32 frame and a USB cable, no account needed
(GitHub issue #904). It puts the signed FrameOS release on a board and tells
the board what frame it is over the same cable, with the same code the
planes' own USB buttons run. Three ways in:

- **A standalone frame.** An ESP32-S3 with no backend and no account: the
  person picks the board (`?board=<preset>` deep links from frameos.net's
  device pages), a name, the Wi-Fi, the time zone (the browser's) and the
  samples to start with. The frame then installs more from its own Scene
  store scene (a frame with no plane installs by itself,
  `docs/scene-store.md`).
- **A backend on plain http.** Browsers offer Web Serial only on a secure
  page, so `http://192.168.1.10:8989` (or Home Assistant at
  `http://homeassistant.local:8123`) cannot reach a board. The backend's USB
  card opens the flasher in a window of its own and hands it the frame
  (the bridge, below).
- **A setup file.** The same frame, saved by the backend's USB card
  ("Download setup file") and dropped onto the page on any computer.

Afterwards the page keeps **board tools** over the cable: the USB log, a new
Wi-Fi network, a restart, and a firmware update that keeps the board's
settings and scenes. That is how a standalone ESP32 updates: the OTA
manifests are its planes' routes, and it has none.

## What it is

- **cloud-frontend's second entry**, `cloud-frontend/src/flasher` (built by
  `build.mjs` next to the frames SPA into `dist/flasher.html`, with the
  samples to start with in `dist/flasher-scenes/`), served by auth-web's
  `app/flash/route.ts`. `src/lib/surfaces.ts` serves it at the root of
  `FRAMEOS_FLASHER_APP_URL` (production: `flash.frameos.net`) the way the
  playground is served (`docs/playground.md`: the proxy marks the request,
  `next.config.ts` rewrites it); without the setting it is `/flash` on the
  cloud origin, as in `pnpm dev`. It ships with every cloud deploy.
- **The engine is shared**: `frontend/src/scenes/workspace/embeddedFlashRun.ts`
  (`flashAndSetUpBoard`, `updateBoardKeepingSettings`, `provisionOverUsb`)
  is what the backend's "Flash FrameOS & set up this frame" and "Update
  firmware, keep settings" run too. A fix to how a board is flashed is made
  there, once; the page only decides what goes in (`flasherLogic.ts`).
  `embeddedFlashShared.tsx` and the modules the engine imports stay free of
  the workspace (no `workspaceLogic`, no `framesModel`): with them the page
  was 5.9 MB, without them 570 KB.
- **Its host is no door to the API.** The session cookie is scoped to the
  registrable domain, so the browser sends it here too, and the page takes
  jobs from pages it does not know. `proxy.ts` takes the cookie and any
  bearer off every request on the flasher host, and the host answers 404 for
  every API path but `GET /api/frames/firmware` and the store's public
  listing and covers (`/api/store/repository.json`,
  `/api/store/scenes/<id>/image`: the scene list's store pages, and a cover
  for a sample with no picture of its own), and its one write,
  `POST /api/flasher/events` ("What is counted" below)
  (`flasherServesApi`). A new thing the page needs from the API goes on that
  list, and must be fine to serve to anyone.
- **No sign-in, no cross-origin opener policy.** It is no app origin
  (`getAppOrigins`). It must never send `Cross-Origin-Opener-Policy`: that
  would cut the bridge's link to the page that opened it.

## Every image is checked against the release signature

`frontend/src/scenes/workspace/releaseFirmware.ts`: the bytes, whatever
handed them over, are hashed (BLAKE2b-512) and checked against the release's
`.minisig` with the FrameOS release key (`frontend/src/utils/releaseSigning.ts`,
the SD image builder's verifier, moved to the shared frontend), and the
signature's trusted comment must name `frameos-<release>-<platform>.bin`,
built from the release and the platform the flasher chose for the chip. Both
planes' `/api/frames/firmware?platform=…&signature=1` answer the `.minisig`
(409 `unsigned_release` without one), as `app/api/frames/sd-image` does. The
flasher writes nothing unsigned; a plane's own flasher writes the plane's
development build (`FRAMEOS_ESP32_GENERIC_FIRMWARE`, served as `local-dev`)
after saying it is unsigned, and nothing else unsigned either.

The cloud's `/api/frames/firmware` needs no session any more (the flasher's
host sends none). What bounds it is what always did: the per-address budgets
(300 listings in 15 minutes and 30 images an hour).

## The bridge

`frontend/src/utils/flasherBridge.ts` is the protocol, `flasherBridgeLogic.ts`
the backend page's half, `cloud-frontend/src/flasher/bridgeClient.ts` the
flasher's.

1. On a page where `webSerialNeedsFlasher()` (no `navigator.serial` on an
   insecure page, or a frame the `serial` permission was not delegated to),
   the backend's USB card (`EmbeddedUsbConnect` → `FlasherBridgeCard`) opens
   `flasherUrl()?bridge=1` in a window, inside the click. `flasherUrl()` is
   `https://flash.frameos.net` unless the backend's `FRAMEOS_FLASHER_URL`
   names another copy (`flasher_url` in its app config).
2. The flasher posts `ready` to `window.opener` (target `*`: it holds
   nothing). The page answers only that window, at the flasher's origin, and
   posts the **job** with the flasher's origin as the target, so the frame's
   API key and Wi-Fi password reach nothing else.
3. The flasher reads the job like a dropped file (`parseFrameSetupDocument`:
   known console keys, no line breaks, never `cloud_url` / `claim_token`),
   pins the sender's origin, shows who asked and what will be written, and
   does nothing until the person clicks and picks the port.
4. The image: the flasher reads the chip, then asks the page for the listing
   and for that platform's image (`listing-request`, `image-request`). The
   page fetches both from its own plane's pipe and transfers the bytes, so a
   backend's flash costs FrameOS nothing and writes the release that backend
   expects. The signature check above is what makes that safe.
5. Back to the page: `status` (phase, line, progress), every USB `log` line
   (into the frame's Logs panel), `flash-size` (the backend records the
   board's flash size), `scenes-uploaded` (the backend marks the USB deploy
   done) and `finished`. After a run the flasher keeps the board's USB log
   stream open and its lines keep coming.

Job kinds: `setup` (flash a blank board and set it up), `update` (the release
around the settings partition, `pushScenes` for the setup's scenes after), and
`provision` (no flash: the settings, and with `withWifi` the Wi-Fi, which is a
Pico's whole step 2).

Checked in Chromium (2026-11-24): a window an http page opens on an https
page is a secure context with `navigator.serial` and keeps `window.opener`;
an https iframe inside an http page is neither. A same-origin frame inherits
the `serial` permission (Home Assistant's ingress over https needs no
bridge).

## The setup document

`GET /api/frames/{id}/embedded/setup` on the backend (`frames.py`), also
the setup file:

```json
{
  "format": "frameos-setup",
  "version": 1,
  "createdAt": "2026-11-24T19:00:00Z",
  "frame": { "id": 12, "name": "Kitchen" },
  "backend": { "url": "http://192.168.1.10:8989" },
  "provisioning": { "…": "embedded_provisioning_plan: settings in order, wifi, warnings" },
  "scenes": ["…what the board's own pull would get…"]
}
```

`scenes` is `embedded_scenes_payload`: one empty scene for a board the
backend renders for (`docs/server-rendering.md` "Nothing to keep on the
board"), the runtime's app keywords, no app test files. The backend's own
flasher reads its post-flash scenes from here too (it used to send the
workspace's list as it was). A field added to the document is read by
`parseFrameSetupDocument` and the backend test (`test_embedded_setup.py`)
together; `version` goes up when a flasher of the old version would write
something wrong.

Why not a partition image of `/state`: most of what makes a frame lives in
NVS, not `/state`; `/state`'s place and size differ per flash layout, which is
known only once esptool has read the chip; and the scene store's files
(index, slots, `make_entry`) have one writer, the firmware. The console
replay tolerates older firmware (`OPTIONAL_ON_OLDER_FIRMWARE`) and costs
seconds (scenes go over a CH340 at about 11 KB/s).

## A standalone frame

`cloud-frontend/src/flasher/standalone.ts`: the boards are the SPA's ESP32-S3
hardware presets (`esp32Hardware.ts`, mirroring the backend's and the
firmware's), plus "Other ESP32-S3 board" (a panel, the XIAO's pins unless
told). A C3 or a Pico is a thin client and needs a plane to draw for it. The
console gets `set hardware` (or `set panel`), a carrier board's panel, the
preset's rotation, `hostname`, `time_zone`, then the Wi-Fi; no `backend`, no
`cloud_url`. A board with no login set refuses its HTTP API's writes, so none
is set.

### The scenes to start with

Every repo sample (`repo/scenes/samples` and `gallery`) that a standalone
ESP32 can run, ticked one by one: `src/flasher/sampleCatalog.ts` reads that
from the scenes, never from a list of names. A layout is left out (it shows
nothing of its own), and so is a scene that needs a Pi (`linux` or `video` in
`sceneNeeds.ts`, `shell` in `sceneAccess.ts`; Files is the one exception, its
video viewer one thing among many) or reads an account's key (`key:<service>`:
a frame with no plane is given none). `build.mjs` bundles the module, runs it
over the repo and writes `flasher-scenes/index.json` (about 30 KB for 101
samples: names, categories, needs, sizes) and one file of scenes per sample
(4 MB in all), which the page fetches only for the samples picked, starting
when Flash is clicked, and beside each its picture (template.json `image`) as
a 128 x 96 JPEG made with sharp (230 KB for all of them; the originals are
17 MB). Two samples with one scene id fail the build.

The list is grouped by category ("System" first, then the store's shelves),
with a search. The Scene store is always on the frame and cannot be unticked.
Any scene may go on any panel: a fast scene runs on e-paper too (the DVD logo
on a fast e-paper, the kitchen sink), so nothing is held back by it. Every
sample shows that picture and is listed by its template name, what the scene
is called (a folder can be named otherwise: `Books` is the ePub reader; the
folder stays what a pick and a preset name). One the store carries opens its
store page in a new tab (the store's public listing, matched by that name,
`sampleList.ts`). Presets tick a
set (`presetPicks` in `standalone.ts`): "A few to start" (a short list by
taste: a clock and the weather, plus the frame's tools on a touch board),
"Interactive LCD scenes" (what needs `touch`, `keys` or `fast`), "Best for
e-paper" (none of those: a suggestion, never a limit), "Everything" (every
sample, on any panel) and "Only the Scene store". A preset
follows the board picked after it; a tick by hand ends that. A preset fills
the board while it has room and says how many did not fit; a set picked by
hand that the board cannot take is refused before the flash: more than 128
scenes, or more than 70% of the layout's `/state` (1 MB on 8 MB of flash, 8
MB on 16, 24 MB on 32; a board the flasher has no preset for counts as 8 MB).
The page says how long the scenes take (`sceneUploadSeconds`): over the cable
at about 11 KB a second deflated to about a third, and onto the board, where
each scene's file costs a walk of `/state` (about 1.5 s on a 32 MB board).
Every sample, 105 scenes and 4.2 MB, took 302 s onto a reTerminal Sticky.

The set goes in batches of up to 512 KB of JSON (the most the board holds in
memory at once, `FOS_SCENES_HELD_MAX_BYTES`), each deflated for
`usb_api scenes-deflated`: the first replaces what the board held, the rest
are added to it (`uploadScenesOverUsbAfterFlash`, which the backend's flasher
runs too; embedded/esp32/README.md "A set over USB"). Firmware through
2026.11.14 does not know the command: it gets the scenes that fit one
`upload-scenes`, then the rest a scene at a time with `scene-put`, and it
holds that first set back until it restarts when it has no network yet (all
of them, during a setup), so the page restarts it once when it refuses a
`scene-put` for it.

On a board that takes taps (its firmware event map swipes: `fos_board.c`
`k_event_maps`, pinned by `flasher-standalone.test.ts`) no scene is marked
`default`, so with no scene of its own choosing it opens on the scene
switcher, its home. On a board of keys the first picked scene that is not the
Scene store is marked `default`: a clock, not the shop.

**A layout** (docs/scene-layouts.md) is picked under the presets, in one
select with each layout's picture: "No layout", then "Made for this board"
(the layouts whose `settings.devices` name it), "Desktops" and "Full screen".
Every repo sample that is one layout a standalone frame can run is offered
(`flasherLayoutOf` in `sampleCatalog.ts`; build.mjs serves each beside the
samples, its file fetched only when it is picked). A board starts on the
layout made for it (the reTerminal Sticky's, and `reTerminal` on the E1001 to
E1004) and any other board on none (`defaultBoardLayout`); a layout picked by
hand stays when another board is picked that can wear it. The layout goes to
the board right after the Scene store, in the first batch, and every scene
names it the way a control plane installs one (`layout: {sceneId}`,
`starterSceneSet`). It is also made the frame's own choice, the frame page's
Layout (`set layout`, after the time zone; `-` with no layout, since a flash
leaves `/state` and a choice from before with it): the scene switcher a tap
board opens on as its home wears that choice alone, never what the scenes
name, and so does a scene installed on the frame later. A board on firmware
from before the key skips it, and only its home goes without. A frame of a backend or of FrameOS Cloud is not given one
here: its scenes and the layout they wear are its plane's, chosen in the
frame's Settings.

## What is counted

The page counts how it is used, for questions like how many boards are
flashed a day, which ones, and how often a flash fails. It stores nothing on
the device and needs no consent: no cookies, no local storage, no PostHog
script. `src/flasher/flasherEvents.ts` sends each event to
`POST /api/flasher/events` on the page's own host (`keepalive`, never
awaited), and auth-web's route (`app/api/flasher/events/route.ts`) passes it
to PostHog with `capturePostHogEvent`, with no person profile
(`$process_person_profile: false`), no location (`$geoip_disable`) and
`surface: "flasher"`. It is rate limited per address.

| Event | When | Properties |
| --- | --- | --- |
| `flasher opened` | the page loads | `entry` (`page`, `bridge`), `usb` (`yes`, `blocked`, `no`), `board` and `board_from_link` for a `?board=` link |
| `flasher flash started` | a flash, update or settings run is clicked, after the form's checks | `kind` (`setup`, `update`, `provision`), `mode` (`standalone`, `bridge`, `file`), `board`, `panel`, `platform`, `preset` (`hand` when picked by hand), `scenes`, `scene_bytes` |
| `flasher flash finished` | that run ends | the same, plus `outcome` (`done`, `written`, `failed`, `cancelled`), `seconds`, and for a setup that is done the detected `platform` and `flash_size` |
| `flasher tool used` | Connect, Set Wi-Fi or Restart in Board tools | `tool` (`connect`, `wifi`, `restart`), `outcome` |

The distinct id is a random visit id made when the page loads and kept only
in its memory: one visit's events belong together, and nothing links one
visit to the next, so "people" in PostHog are visits. A port prompt the person
closes is a `cancelled` run. The route keeps only what
`src/lib/flasher-events.ts` lists (an event name, a few words per property,
catalog keys, counts) and answers 400 to anything else: never a frame's name,
a Wi-Fi network, a backend's address or a scene. A new property goes on that
list and on the privacy page's flasher paragraph (`app/legal/privacy`), which
says what is collected.

## Deploying

`flash.frameos.net` is a proxied Cloudflare record for the box and a
`server_name` on the nginx server block, like the playground's
(`docs/deployment.md`), with `FRAMEOS_FLASHER_APP_URL=https://flash.frameos.net`.
Without it the flasher is `https://cloud.frameos.net/flash`, which works the
same; the backend's default (`https://flash.frameos.net`) needs the host.
