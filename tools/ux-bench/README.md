# UX bench

Every repo scene (`repo/scenes/samples` and the galleries) on every bench
board, without the boards: the wasm runtime run as each board's own runtime runs (its size,
rotation, panel format and canvas, round glass, keys, event map, touch, the
ESP32's memory ceiling), driven the way a person drives it. What
`tools/frame-bench` does for speed and stability on the hardware, this does
for how scenes look and behave, in minutes and on any machine.

For each scene and virtual panel (`panels.json`), in a fresh runtime with the
scene, the scenes of its own folder (a split's panels) and a dozen companions
installed (`ux.mjs`):

- **render**, cold and warm, screenshotted; blank pictures, error frames, log
  errors, out-of-memory under the device's ceiling; on a round panel, how
  much is drawn in the corners nobody sees;
- **every element on the screen**: each UI element the layout placed, whole
  (`frameos_wasm_ui_elements`; the press map is cut at the canvas, so it
  cannot say), past or off the panel in no box that scrolls (out of reach),
  cut by a round glass, or two pressable ones overlapping;
- **keys**: each key pressed and held, and two held together where the map
  makes that Back, as relayed edges (`frameos_wasm_device_input`, timed by
  `atMs`); what came up (`report.py` holds it to the board's event map: a held
  arrow walks the scenes, Home opens the list, ...);
- **edge swipes** on touch panels, from the rim on a round one;
- **the keys' walk** on every board with keys (docs/jsx-ui.md "Keys"): Next
  pressed until the ring comes round to where it started, each element it
  rings named (`frameos_wasm_ui_elements`' `key`, the kept state's `ring`):
  an element to press it never reaches, a ring on an element the panel does
  not show, a Next that leaves the scene or does nothing; then Action on
  three of the elements it rang, spread over the walk (does any of them do
  anything?). On a keys-only e-paper this is the only way into a scene;
- **every text on the screen** (`frameos_wasm_ui_texts`, which only the wasm
  runtime records, and only once the harness asks): under the size a person
  reads (`--minText`, 9 canvas px), past the panel's edge or cut by a box that
  clips it (an ellipsis is counted apart), broken inside a word, printed over
  another text, cut by a round glass;
- **taps** on every element there is to press (`--taps`, 16 at most, spread
  over them): did it do anything, how long did it take (fetching left out);
- **Back**: after a tap, or Action on the keys' walk, that went to another
  page of the scene (most of the picture and of its elements changed, and
  what was pressed went with them), the frame's Back as the board gives it (a
  Back key, two keys together, the swipe in from the left): did the page
  before come back (docs/buttons.md)?
- **a scroll** (a drag up the middle): whether the scene's own view scrolls,
  that is, has content past the panel;
- **every box that scrolls**, flicked to its top and dragged until it goes no
  further: does it move under a finger, and is what it ends with shown whole?
- on a round panel, how much of the ring between the inscribed square and the
  glass's edge a scene uses (a "square in the middle").

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
python3 tools/ux-bench/report.py ~/.frameos-bench/ux/run --baseline ~/.frameos-bench/ux/run-before  # + what got slower
# (compare runs made under the same load: run_all.sh beside run_extra.sh on 12 cores made the
#  E1003's games read 2.5x slower; alone, main and branch timed the same)

node tools/ux-bench/ux.mjs --wasm <dir> --panel sticky-landscape --out <dir> --layout "reTerminal Sticky layout" --builtins 1
UX_REPO=<other checkout> node tools/ux-bench/ux.mjs ...   # that checkout's samples
python3 tools/ux-bench/sheet.py out.png 300 4 a.png b.png ...                     # screenshots side by side
```

- `--builtins 1`: the scene list with 45 scenes, dragged and walked by the
  keys; the settings of scenes with many fields; the frame page. Each is a
  section: one the runtime quits in (the model's memory ceiling) is a
  `<section>-runtime-exit` entry in `builtins.json`, and the next starts in a
  fresh runtime. The model can be stricter than a board: the E1004 held
  sideways went from Clock's settings to 2048 on the board (6.9 s, no
  shortage) where the wasm runtime quit.
- `--layout <folder>`: every scene wears that layout sample.
- HTTP goes through the backend renderer's guarded fetch child and is cached
  in `~/.frameos-bench/ux/http-cache`, so a run is repeatable and does not
  hammer the APIs. Only answers under 400 are kept: a refusal kept once would
  show for good.
- The contact sheets are for looking at: what a scene looks like is the one
  thing the report cannot judge. A sheet a panel, about fifty scenes each.

`UXDEBUG=1` echoes the runtime's output and its log lines to stderr as the
harness runs, for a scene that does something unexpected. `UXWALKDEBUG=1`
keeps every element the keys stop at, with its box, on each step of the walk
(`--steps focus --scenes '^To-do$'`), for a walk that goes somewhere odd.

`device_ux.py <port> <board>` is the part a board has to do itself: each
edge swipe through its own touch task (`touch drag`) and each key through its
dispatcher, timed by the board's log, checked against the same event map.
Book the board first (`tools/frame-bench/boards.py`).

Things it found the first time (2026-11-27): a scene that failed to start
swallowed every key and swipe on an ESP32; the pixel games drew in a quarter
of the reTerminal E1003 at its new render scale; pixie drew an SVG whose
viewBox starts away from 0 off to one side when scaled; server rendering sent
no User-Agent; the Sticky's landscape home screen left the scene list one row.
The fourth time, with texts, every element and Back: some twenty scenes open
a page (a game's Options, a store scene, a notebook list) that the frame's
Back does not leave, though each has a Back button of its own on it.
`report.md` ends with the slowest interactions and `timings.json` keeps every
scene's, so a later run compares (`--baseline`).
The keys' walk, the third time: a list paged to its end and round never came
back to its top (only what shows of a box answers), a list that ends at its
box's edge was never paged at all, and a page turn rang a row twice.
