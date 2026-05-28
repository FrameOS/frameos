# Native Inky Driver Notes

This driver covers explicit Pimoroni Inky Impression variants whose panel
protocol is known and can run without the Python `inky` package:

- `pimoroni.inky_impression_7_3`: original 7.3" 7-colour AC073TC1A panel.
- `pimoroni.inky_impression_5_7`: original 5.7" 7-colour UC8159 panel.
- `pimoroni.inky_impression_4_7_color`: original 4.0" 7-colour UC8159 panel.
- `pimoroni.inky_impression_4_2025`: 4.0" 2025 Spectra 6 / E640 panel.
- `pimoroni.inky_impression_7`: 7.3" 2025 Spectra 6 / E673 panel.
- `pimoroni.inky_impression_13`: 13.3" 2025 Spectra 6 / EL133UF1 panel.
- `pimoroni.inky_phat_4`: 2.13" four-colour JD79661 pHAT panel.
- `pimoroni.inky_phat_black`, `_red`, `_red_ht`, `_yellow`: legacy 2.13" pHAT panels.
- `pimoroni.inky_phat_ssd1608_black`, `_red`, `_yellow`: SSD1608 2.13" pHAT panels.
- `pimoroni.inky_what_4`: 4.2" four-colour JD79668 wHAT panel.
- `pimoroni.inky_what_black`, `_red`, `_red_ht`, `_yellow`: legacy 4.2" wHAT panels.
- `pimoroni.inky_what_ssd1683_black`, `_red`, `_yellow`: SSD1683 4.2" wHAT panels.

The catch-all `pimoroni.inky_impression` and `pimoroni.inky_python` devices
remain on `inkyPython` because they still rely on EEPROM auto-detection or
unported panel protocols.

## Attribution

This native Nim driver is a FrameOS port of the panel knowledge maintained by
Pimoroni in their open-source `pimoroni/inky` Python library:

https://github.com/pimoroni/inky

Pimoroni's driver code is the source of truth for the panel command sequences,
GPIO/SPI pin mappings, display variant mappings, colour indices, busy-wait
behaviour, and panel-specific transfer details used here. FrameOS keeps the
runtime native so deployed frames do not need to carry a Python interpreter, but
the low-level hardware behaviour mirrors Pimoroni's work. See the per-driver
links in "Upstream References" below for the exact Python modules used while
porting.

## Hardware Validation

The following Pimoroni devices have been tested on hardware and confirmed
working with the native Nim driver:

- `pimoroni.inky_impression_7_3`: 7.3" original 7-colour Inky Impression.
- `pimoroni.inky_impression_7`: 7.3" 2025 Spectra 6 Inky Impression.
- `pimoroni.inky_what_yellow`: 4.2" black/white/yellow Inky wHAT.

The remaining pHAT, wHAT, and Inky Impression variants use the same panel
families and transfer paths as the tested devices above, so they are expected
to work unless their board revision differs from Pimoroni's current Python
driver behaviour.

## Upstream Sync

Synced against Pimoroni `inky` 2.4.0, released April 14, 2026. The 2.3.0 and
2.4.0 upstream changes since the previous Python fallback pin are covered here:

- 2.3.0 added Spectra 6 4.0" / E640 support. FrameOS maps that to
  `pimoroni.inky_impression_4_2025`, with `_4` and `_4_spectra6` as aliases.
- 2.4.0 added AC Waveform Spectra 6 EEPROM variants. Upstream maps those to
  the existing E673 7.3" and EL133UF1 13.3" drivers. FrameOS uses the
  product-level `pimoroni.inky_impression_7` and
  `pimoroni.inky_impression_13` device names for these panels because the
  transfer paths are identical.
- The native E673 render path includes Pimoroni's post-refresh PSR reset, and
  the native EL133UF1 init sequence matches the updated 2.4.0 values.
- `frameos/vendor/inkyPython` is pinned to `inky==2.4.0` so the Python fallback
  can auto-detect EEPROM variants 25, 26, and 27 as well.

## Current Pin Maps

The native Inky panels use Pimoroni's HAT pinout rather than the Waveshare HAT
pinout:

| Panel | Reset | Busy | DC | CS0 | CS1 | SPI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 7.3" 7-colour | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 5 MHz |
| 5.7" 7-colour | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 3 MHz |
| 4.0" 7-colour | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 3 MHz |
| 4.0" 2025 | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 1 MHz |
| 7.3" 2025 | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 1 MHz |
| 13.3" 2025 | GPIO27 | GPIO17 | GPIO22 | GPIO26 | GPIO16 | 10 MHz |
| 2.13" pHAT 4-colour | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 1 MHz |
| 2.13" pHAT legacy/SSD1608 | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 488 kHz |
| 4.2" wHAT 4-colour | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 1 MHz |
| 4.2" wHAT legacy | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 488 kHz |
| 4.2" wHAT SSD1683 | GPIO27 | GPIO17 | GPIO22 | GPIO8 | - | 10 MHz |

Buttons are handled by the shared `gpioButton` driver. Inky Impression boards
map A/B/D to GPIO 5/6/24. Button C is GPIO16 except on the 13.3" board, where
it is GPIO25. Inky pHAT and wHAT boards do not get automatic GPIO buttons.

## Upstream References

The current command sequences mirror Pimoroni's Python drivers:

- AC073TC1A: https://github.com/pimoroni/inky/blob/main/inky/inky_ac073tc1a.py
- UC8159: https://github.com/pimoroni/inky/blob/main/inky/inky_uc8159.py
- E640/E673/EL133UF1: https://github.com/pimoroni/inky/tree/main/inky
- JD79661: https://github.com/pimoroni/inky/blob/main/inky/inky_jd79661.py
- JD79668: https://github.com/pimoroni/inky/blob/main/inky/inky_jd79668.py
- Legacy pHAT/wHAT: https://github.com/pimoroni/inky/blob/main/inky/inky.py
- SSD1608 pHAT: https://github.com/pimoroni/inky/blob/main/inky/inky_ssd1608.py
- SSD1683 wHAT: https://github.com/pimoroni/inky/blob/main/inky/inky_ssd1683.py

## Nimifying Another Inky Panel

1. Split the product into an explicit `pimoroni.inky_*` device key
   in `backend/list_devices.py` and `frontend/src/devices.ts`. Leave ambiguous
   devices on `pimoroni.inky_impression` until their protocol is known.
2. Confirm the upstream Pimoroni Python panel class, including resolution,
   command sequence, SPI speed, GPIO pins, busy wait behaviour, native colour
   indices, and any rotation/splitting performed before transfer.
3. Add the device key to `INKY_NATIVE_DEVICES` in
   `backend/app/drivers/devices.py` and to the release registry in
   `backend/app/codegen/release_drivers_nim.py`.
4. Add a `PanelKind`, `PanelSpec`, pin map, init sequence, and render/update
   routine in `panels.nim`. Keep the frame-facing width/height in the same
   orientation the Python API expects, then rotate or split packed nibbles only
   at transfer time if the panel glass expects it.
5. Use the existing `ditherPaletteIndexed` and `drivers/waveshare/preview`
   helpers when the colour packing matches an existing Waveshare colour option.
   Add a new colour option only if the native panel indices or preview palette
   cannot be represented by the current options.
6. Ensure setup enables SPI and adds `dtoverlay=spi0-0cs` when the driver
   manually controls chip-select GPIOs.
7. Add or update tests for `drivers_for_frame`, release-driver selection, and
   any panel-specific button pin defaults.
8. Run focused checks:
   - `flox activate -- nim check src/drivers/inky/inky.nim`
   - `cd backend && pytest app/drivers/tests/test_devices.py app/tasks/tests/test_release_drivers_nim.py`
   - For hardware validation, enable frame debug logs and verify command/data
     progress, busy waits, and GPIO button events on the target frame.
