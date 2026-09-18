# Scene rhythm — what is left

*Rewritten 2026-09-18, the day the design shipped. How it works now lives in
`docs/scene-rhythm.md`; this file carries only what that work left open. When
an item ships, delete it.*

Shipped: per-scene-node due times with a fresh `nextSleep` per node, the loop
waking at the minimum due time on all three hosts, the paint log and overpaint
rule, partial passes into the persistent canvas (ESP32, Pi, wasm), the
persistent pre-overlay canvas on the Pi runner, targeted due-marking for
`render` / `setSceneState`, the three pixel-reuse tiers (transient memory, kept
memory, storage for deep-sleep frames), `buildSplitScene` keeping settings, the
editor's "Auto" interval and per-panel rhythm, and the wake-cadence logging.

## Verified on hardware (E1004, 2026-09-18)

Partial passes, the wake contract, and the storage tier across deep-sleep
wakes all ran on the bench E1004 (numbers in `docs/scene-rhythm.md`). Two
firmware bugs it found are fixed on the branch: the lazy loader never made a
split's panels resident, and an exception at a Nim C boundary poisoned the
runtime silently. SPIFFS garbage collection turned the storage tier's 1.9 MB
write into an eight-minute stall, and on a deep-sleeping e-ink frame the wake
itself costs a minute, so the tier now exists only where there is an SD card,
and only stores when the measured arithmetic (run time minus read-back, over
the wakes it sits out, against the write) is a clear win; otherwise the child
just renders again.

Flash: the branch is +34.5 KB on the ESP32-S3 image with the memory and
storage tiers compiled out (`-d:frameosRhythmMemory` / `-d:frameosRhythmStorage`
opt them in; they were +22 KB together). Of what is left, ~10 KB is
scene_rhythm.nim, ~9.5 KB the interpreter's pass driver and scene-node
handling, ~2 KB the embedded-scene loading, and ~7 KB is GCC inlining noise in
modules whose generated C did not change.

## Not yet verified on hardware

- [ ] **The 13.3E6** (16 MB PSRAM, RGBX canvas, SD card): the transient
  memory tier should be affordable there, and the storage tier's SD path
  (`<assets>/.rhythm`) has only run in host tests. Watch
  `rhythm:snapshot:refused` and `rhythm:store` timings.
- [ ] **Wall-clock-aligned wake schedule** (`wake_schedule`): the render task
  now aligns to `frameos_nim_wake_cadence()`. Check a minute clock + photo
  wakes on the minute and the photo does not drift.
- [ ] **A Pi with HDMI at 4K**: the output copy is one extra canvas-sized
  memcpy per pass (33 MB). Measure it against a 5 fps clock; if it shows, skip
  the copy when no overlay, flip or rotation is active *and* the driver is
  known not to write to its input.
- [ ] **Scene init on the ESP32 is 12 s of a deep-sleep wake** (QuickJS
  compiles for every code node of every resident scene, including panels
  that then only get read back from storage). Not rhythm's, but it is what
  bounds the storage tier's saving on that board.

## Open

- [ ] **A floor per device class.** A 0.2 s child on Spectra 6 refreshes the
  panel back to back forever, and a one-minute clock on a deep-sleeping
  battery frame leaves it 1–10 s of sleep per ~70 s wake (seen on the E1004).
  Today that is the user's problem, as it is for a fast top-level scene.
  Options: clamp the effective child interval to the measured driver time (or
  the wake cost on a deep-sleep frame), or warn in the split drawer when a
  panel's rhythm is far below what the frame can show.
- [ ] **A raw flash partition for the storage tier**, if it ever earns one:
  SPIFFS is out (GC stalls of minutes), so SD-less boards re-render. A raw
  partition written with `esp_partition_write` would cost ~8 s per store
  deterministically and read back memory-mapped — but it is a partition table
  change, i.e. a relayout for every board, for a saving the E1004 numbers say
  is small next to the fixed wake cost.
- [ ] **Cloud activation after a version bump** resolves the active scene id
  against the *deployed* version's scenes.json (`deviceSceneIdForFrame`), so a
  `frame_scene_install` of a new version that renamed its scene ids sends the
  old id and the device logs `scene selection failed`. Seen on the bench;
  worked around by activating by runtime id.
- [ ] **Overpainted children on deep-sleep frames** re-run on every wake: the
  storage tier only writes rectangles whose canvas pixels are the node's own.
  Writing the kept snapshot instead would cover it; needs the memory for the
  snapshot, which the boards that deep sleep mostly do not have.
- [ ] **Partial panel refresh.** A partial pass still hands the driver the
  whole canvas. The due rectangles are known (`RhythmPassInfo`); drivers with a
  partial-update mode (IT8951, some Waveshare panels) could take them as a hint.
- [ ] **The scene-node user docs** (frameos-docs repo) should explain rhythm,
  "Auto" on splits, and the deep-sleep storage tier.
- [ ] **Generic "follows its children"**: only scenes with
  `settings.splitScreenLayout` get it. A hand-built container scene would need
  a setting of its own; nobody has asked.
