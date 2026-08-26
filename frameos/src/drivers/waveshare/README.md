# Waveshare e-Paper drivers

`ePaper/` is the Waveshare reference tree
(https://github.com/waveshareteam/e-Paper/blob/master/RaspberryPi_JetsonNano/c/lib/e-Paper/)
plus a handful of FrameOS-maintained forks. Last synced with upstream commit
`a794fbc` (2026-08). Every vendor driver additionally carries the FrameOS
busy-wait timeout (`EPD_BUSY_TIMEOUT_MS`, added in #230) — re-apply it to a
freshly copied file, or the panel can hang the render thread forever. **The C files are the one
implementation of every panel, on every target:**

- Raspberry Pi / Linux: each `EPD_*.nim` is a c2nim-generated binding whose
  first line, `{.compile: "EPD_*.c".}`, compiles the C into the driver
  library. `DEV_Config.c` (lgpio) is the hardware layer.
- ESP32: `embedded/esp32/components/frameos_display` compiles the same
  `EPD_*.c` files against its own `DEV_Config_esp.c` (ESP-IDF). Which panels
  are linked comes from `generate_panel_table.py`, which reads the metadata
  the backend derives from the `.nim` bindings.
- Pico: `embedded/pico/src/drivers` carries small table-driven ports of the
  init sequences; it does not link this tree.

There are no hand-written Nim ports of panel drivers any more (there were,
for the 4.0" E, 4.01" F, 7.3" E and 13.3" E; the ESP32 port needed the C
back and the two copies drifted). Panel-level fixes go in the C file once.

`DEV_Config.h` is the contract the drivers are written against: pins are
runtime variables (`DEV_SetPinConfig`, with a second chip select for the
dual-controller 13.3" E), busy waits are bounded by `EPD_BUSY_TIMEOUT_MS`,
and `DEV_Debug_Log(action, jsonMembers)` is the structured debug channel;
`DEV_Error` reports what a driver cannot recover from (a busy timeout) and on
the Pi turns the render into a failed one via `raiseIfDriverError`
(on Linux it becomes a `driver:waveshare:debug` event in the frame log when
driver debug logging is on; on ESP32 it prints at debug level). The ESP32
header `include/DEV_Config.h` must declare the same API.

## FrameOS-maintained forks (do not overwrite on resync)

| File | Why it differs from the vendor tree |
| --- | --- |
| `EPD_13in3e.c/.h` | dual chip select, bounded busy waits, debug events, `EPD_13IN3E_SetVariant` for the Seeed reTerminal E1004's T133A01 panel tuning, `DisplayPart` |
| `EPD_7in3e.c/.h` | bounded busy waits, debug events, bulk SPI framebuffer write, `EPD_7IN3E_SetPhotoPainterMode` (Waveshare PhotoPainter PMIC board) |
| `EPD_4in0e.c`, `EPD_4in01f.c` | bounded busy waits |
| `EPD_13in3k.c`, `EPD_2in7_V2.c`, `EPD_4in26.c`, `EPD_5in79.c`, `EPD_7in5b_V2.c` | `LUT_DATA_4Gray` / `partFlag` globals marked `static`: the ESP32 firmware links every driver into one binary and the vendor names collide |
| `EPD_7in5_V2.c/.h` | vendor `EPD_7in5_V2_old` (the pre-V3 panel) plus FrameOS partial refresh (`Init_Partial`, `Display_PartialBase`, `Display_Partial`); `EPD_7in5_V2_gray` is the vendor's current `EPD_7in5_V2` |
| `EPD_13in3b.c/.h` | FrameOS partial refresh (`Display_Base`, `Display_PartialBase`, `Display_Partial`) |
| `DEV_Config.c/.h`, `DEV_Debug.c`, `Debug.h` | FrameOS hardware layer (see above); not vendor code. `DEV_Debug.c` is platform-neutral (command/data/preview events, `DEV_Busy_Wait`) and is compiled on the Pi and the ESP32 alike |

Other driver families: `it8951/` (10.3" IT8951 controller, native Nim, Pi
only) and `epd12in48/` (12.48" multi-controller boards, C + bindings, Pi only).

## Resyncing from the vendor tree

1. Copy new C sources (`EPD_*` files) into `ePaper/`, skipping the forks listed above.
   - Rename `EPD_7in5b_V2_old.*` as `EPD_7in5b_V2.*`
   - Rename `EPD_7in5b_V2.*` to `EPD_7in5b_V2_gray.*`
2. Run `cd frameos/src/drivers/waveshare/ePaper && make` to regenerate the `.nim` bindings.
3. Run `cd backend && python3 list_devices.py` and verify the driver is listed with the right resolution and color.
4. If not, you might need to edit the auto-detection routine in `convert_waveshare_source` in `backend/app/drivers/waveshare.py`.
5. If the color remains `Unknown` and the `Display` function takes just one parameter, update the `VARIANT_COLORS` dictionary with the right color.
6. Finally, copy the output of `list_devices.py` into `frontend/src/devices.ts`.
7. Reapply the `static` on the `LUT_DATA_4Gray` globals (table above).
