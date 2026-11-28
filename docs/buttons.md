# Buttons: one standard for every board

Every FrameOS board with keys works the same way. A key plays one of five
roles. Each role has a press and a hold, and nothing else: no double or
triple press. This page is the standard, why it is the way it is, and where
it lives in the code. The events are in `docs/events.md` ("Buttons", "Event
map"), the contract in `docs/events-contract.json` (`buttons`).

## The five keys

| Key | Role on the wire | Press | Hold (acts at 1 s, while still held) |
|---|---|---|---|
| **Action** | `primary` | the scene's: Enter on a UI, refresh on a scene with nothing to press | the voice chat on a board with a microphone, else **Home** |
| **Next / Prev** | `next` / `prev` (configured as `left` / `right` / `up` / `down` where a key's place is a direction) | the scene's: the next or previous thing to press on a UI; on a scene with nothing to press, its `forward` / `back` | the next / previous scene |
| **Back** | `back` | `back`: a keyboard or list on the screen goes away, then the scene goes back (its page or photo before), the scene list and the settings close | **Home** |
| **Home** | `menu` | the scene list; pressed again, it closes | the scene's settings |
| **Screen** | `screen` | the screen off and on (an LCD) | the voice chat where it is the board's only way to talk, else **Home** |

**Home** is the scene list (`sceneSwitcher`, docs/scene-switcher.md). From it
every scene opens, and its gear opens the settings of the scene it was opened
from, whose own gear is the frame page.

`refresh` and `secondary` are older role names a frame may still be
configured with: they are read as `primary`.

## When a board lacks a key

1. **No Back key:** two keys pressed together are Back. Pressed and let go,
   `back`; held, Home. Nobody presses two keys at once by accident, so this
   costs nothing else, and no press waits for it.
2. **No microphone:** the Action key held is Home.
3. **A touch screen:** a swipe in from the left edge is `back`, from the right
   `forward`, up from the bottom Home, down from the top the scene's
   settings. A touch board's keys do what touch cannot: the screen and the
   voice chat.
4. **One key, no glass** (a TRMNL, a C3): pressed, the scene's; held, Home. In
   Home that key walks the tiles, and the hold opens the one it is on.
5. **A crown or a knob:** each detent is one Next or Prev press, and pushing
   it is Action. A turn has no hold.

## Rules

- **A short press belongs to the scene; holds belong to the frame.** The keys
  with one job (Home, Back, Screen) are the frame's pressed too, and Back
  offers itself to the scene first.
- **No double or triple press in any default.** Two presses are two presses:
  the calculator's same digit twice, Next twice is two steps. A press is
  delivered the moment the key comes up, so nothing waits 350 ms for a second
  one. A map of someone's own may still bind a `doublePress` or `triplePress`
  of a key: only that key waits.
- **Every frame with keys reaches Home.** The one exception is the Waveshare
  13.3E6, whose one key held is its voice key (the voice chat can switch to
  any scene).
- **Bind by role, not label.** A preset states every key's role
  (`EMBEDDED_BOARD_KEYS`); `roleByLabel` is only the default for a key nobody
  gave one, on a frame configured by hand.
- **Next is towards the right or the bottom of the picture as the frame shows
  it.** A key whose place on the board is a direction is configured as that
  direction, unrotated (`left`, `right`, `up`, `down`), and is delivered as
  `next` or `prev` through the frame's rotation and flip, the same transform a
  touch goes through (`input_state.nim` `facing`). A reTerminal turned upside
  down has its next key on the right, and its printed arrows point the right
  way again. A knob's clockwise stays clockwise, and the keys with no
  direction (Action, Back, Home, Screen) mean the same however the frame
  hangs.
- **Next/Prev and forward/back are two things.** Next and Prev move across
  what is on the screen (the focus). `forward` and `back` move through the
  scene's own history (its pages, its photos). On a scene with nothing to
  focus they are the same, so there the keys are the scene's `forward` and
  `back` (`event_loop.nim`, a press no scene hears).
- **Back never switches the scene.** A frame's scenes sit side by side, not on
  a stack. Back held is Home.
- **A hold acts at the threshold, with a sound, and once.** Whoever holds a
  key knows when to let go.
- **The voice key is the Action key held** (the Screen key on a board without
  one). The firmware finds it by its label in the map.
- **Motion is no key of the standard.** A frame with an accelerometer (the
  Sticky, the round AMOLED) can bind a flick, a tilt, a shake or laying it
  face down like a key (docs/events.md "Event map", docs/accelerometer.md), but
  no preset does: a motion in the frame's map is taken from every scene, a
  tilting game included. One scene's ("Map buttons": a flick as `forward`
  turns a reader's page) is the place for one.

## Every board

| Board | Action (held) | Prev / Next | Back | Home | Screen |
|---|---|---|---|---|---|
| reTerminal E1001 / E1002 | REFRESH (voice) | RIGHT / LEFT (see below) | both arrows together | both arrows held | — |
| reTerminal E1003 | REFRESH (voice) | RIGHT / LEFT (see below) | both arrows, or a swipe | held, or a swipe | — |
| reTerminal E1004 | REFRESH (Home) | LEFT / RIGHT | both arrows together | REFRESH held, both arrows held | — |
| reTerminal Sticky | AI (voice) | UP / DOWN | two keys, or a swipe | two keys held, or a swipe | — |
| CrowPanel 5.79" / 4.2" e-paper | OK (Home) | PREV / NEXT | EXIT | HOME; EXIT held | — |
| PhotoPainter | KEY1 (voice) | BOOT is Next | KEY1 and BOOT together | held together | — |
| XIAO ePaper EE02–EE05 | KEY2 (Home) | KEY1 / KEY3 | two keys together | held together | — |
| TRMNL DIY kits | BOOT (Home) | KEY3 or KEY1 is Next | both together | held together | — |
| TRMNL OG / BWRY, XIAO 7.5", C3 OLED, XTEINK X4 | the one key (Home) | — | — | the key held | — |
| 13.3E6 | BOOT (voice) | — | — | — | — |
| SenseCAP Indicator, Sunton 7", CrowPanel Advance 7.0" | — | — | swipe | swipe; the key held | BUTTON / BOOT |
| CrowPanel Advance 2.8" | — | — | swipe | swipe | BOOT (held: voice) |
| AMOLED 1.75" | BOOT (voice) | — | swipe | swipe; PWR held | PWR |
| CrowPanel 2.01" watch | the crown pushed (voice) | the crown turned | swipe | the power key; BOOT held; swipe | BOOT |
| CrowPanel 1.46" rotary | the knob pushed (Home) | the knob turned | swipe | BOOT held, the knob held; swipe | BOOT |
| Guition 4848S040, every HyperPixel | — | — | swipe | swipe | — |
| Inky Frame (Pico) | A (Home) | B / C | D | E; D held | — |
| Inky Impression (Pi) | A (Home) | B / C (they point up and down) | D | D held | — |

The E1001-E1003's arrows are printed for someone behind the frame: seen from
the front, the key labelled RIGHT is the left one of the pair and LEFT the one
beside the green REFRESH key. So unrotated RIGHT is Prev and LEFT Next (their
`EMBEDDED_BOARD_KEYS` directions are `left` and `right`), and turned upside
down the other way round. The Sticky's UP and DOWN are up and down in the
portrait it is held in, 270 degrees from its panel, so on the panel unrotated
they are `left` and `right`. A direction is always where the key sits on the
panel unrotated, seen from the front.

The XIAO ePaper boards' key order and the PhotoPainter's (which key is easier
to reach) have not been checked on the hardware yet.

## Where it lives

- **The standard:** `backend/app/utils/button_standard.py` `default_event_map`
  makes a board's map of its keys' roles, its glass and its microphone.
- **The boards:** `EMBEDDED_BOARD_KEYS` in
  `backend/app/tasks/embedded_firmware.py`, every key of every hardware preset
  and its role; a preset's `gpioButtons` and `eventMap` come from it. The Linux
  devices with keys are `DEVICE_GPIO_BUTTON_DEFAULTS` in
  `backend/app/drivers/devices.py` (with the SPA's
  `frontend/src/utils/deviceGpioButtons.ts`).
- **The copies, generated:** `frameos/tools/generate_board_keys.py` writes the
  firmware's table (`embedded/esp32/main/fos_board_keys_gen.h`: each rule once,
  what the rules have in common as one-byte words (`k_rule_words`, put back by
  `fos_board.c`), each board its rules and its keys' roles), the SPA's
  (`frontend/src/generated/boardKeys.gen.ts`) and the Linux devices' maps
  (`frameos/src/frameos/device_event_map_gen.nim`). The backend suite runs
  its `--check` (`test_board_keys.py`). Change a board in the backend, run the
  generator, never edit a copy.
- **A key's role on an ESP32:** the button task sends it with every edge
  (`fos_board_key_role`), so BOOT is Action on one board and Screen on another.
- **The runtime:** `input_state.nim` (a press at its up, two keys together,
  `facing`), `event_loop.nim` (a next or prev press no scene hears is its
  `forward` / `back`; the scene list's way back and its gear),
  `system/sceneSwitcher/scene.nim`.
- **Frames that exist:** the backend's migration `d1b5e7a9c3f2` gives a frame
  whose stored map is still its preset's old one the new map. A map anyone
  changed is kept. An ESP32 does the same for itself, for the boards no
  backend holds (set up in the browser flasher, linked to the cloud): every
  board stored the map it came with in its settings, and a stored map that is
  its preset's old one (the `was` hash in `fos_board_keys_gen.h`, from the
  migration's frozen copies) or today's is the board's own, which the board
  no longer stores (`fos_board_event_map_is_default`, `fos_config.c`): the
  next standard comes with the next update.
