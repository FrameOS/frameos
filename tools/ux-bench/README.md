# UX bench

Every sample scene (`repo/scenes/samples`) on every bench board, without the
boards: the wasm runtime run as each board's own runtime runs (its size,
rotation, panel format and canvas, round glass, keys, event map, touch, the
ESP32's memory ceiling), driven the way a person drives it. What
`tools/frame-bench` does for speed and stability on the hardware, this does
for how scenes look and behave, in minutes and on any machine.

For each scene and virtual panel (`panels.json`), in a fresh runtime with the
scene and a dozen companions installed (`ux.mjs`):

- **render**, cold and warm, screenshotted; blank pictures, error frames, log
  errors, out-of-memory under the device's ceiling; on a round panel, how
  much is drawn in the corners nobody sees;
- **keys**: each key pressed and held, and two held together where the map
  makes that Back, as relayed edges (`frameos_wasm_device_input`, timed by
  `atMs`); what came up (`report.py` holds it to the board's event map: a held
  arrow walks the scenes, Home opens the list, ...);
- **edge swipes** on touch panels, from the rim on a round one;
- **taps** on every region the press map says takes one (spread out, six at
  most): did the picture change, how long did it take;
- **a scroll** (a drag up the middle): whether the scene's own view scrolls,
  that is, has content past the panel.

The pointer goes in as the glass reports it (panel pixels, turned by the
frame's rotation), so a rotated frame is driven as it really is.

```
# the runtime under test, and the panels (from the backend's presets)
frameos/tools/build_wasm.sh --out ~/.frameos-bench/ux/wasm
(cd backend && PYTHONPATH=. python3 ../tools/ux-bench/dump_presets.py) | sed -n '/^{/,$p' > /tmp/presets.json
node --experimental-strip-types tools/ux-bench/gen_panels.mjs /tmp/presets.json

tools/ux-bench/run_all.sh ~/.frameos-bench/ux/wasm ~/.frameos-bench/ux/run      # every panel, ~10 min
tools/ux-bench/run_extra.sh ~/.frameos-bench/ux/wasm ~/.frameos-bench/ux/extra  # the reTerminal layouts both ways, the built-in scenes
python3 tools/ux-bench/report.py ~/.frameos-bench/ux/run --sheets                # issues.json, report.md, a contact sheet per panel

node tools/ux-bench/ux.mjs --wasm <dir> --panel sticky-landscape --out <dir> --layout "reTerminal Sticky layout" --builtins 1
UX_REPO=<other checkout> node tools/ux-bench/ux.mjs ...   # that checkout's samples
python3 tools/ux-bench/sheet.py out.png 300 4 a.png b.png ...                     # screenshots side by side
```

- `--builtins 1`: the scene list with 45 scenes, dragged and walked by the
  keys; the settings of scenes with many fields; the frame page.
- `--layout <folder>`: every scene wears that layout sample.
- HTTP goes through the backend renderer's guarded fetch child and is cached
  in `~/.frameos-bench/ux/http-cache`, so a run is repeatable and does not
  hammer the APIs.
- The contact sheets are for looking at: what a scene looks like is the one
  thing the report cannot judge. A sheet a panel, about fifty scenes each.

`device_ux.py <port> <board>` is the part a board has to do itself: each
edge swipe through its own touch task (`touch drag`) and each key through its
dispatcher, timed by the board's log, checked against the same event map.
Book the board first (`tools/frame-bench/boards.py`).

Things it found the first time (2026-11-27): a scene that failed to start
swallowed every key and swipe on an ESP32; the pixel games drew in a quarter
of the reTerminal E1003 at its new render scale; pixie drew an SVG whose
viewBox starts away from 0 off to one side when scaled; server rendering sent
no User-Agent; the Sticky's landscape home screen left the scene list one row.
