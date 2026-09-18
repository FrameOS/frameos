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

## Not yet verified on hardware

None of this has run on a device. Everything below was compiled (the ESP32-S3
firmware links) and is covered by host tests, not benched.

- [ ] **E1004 (8 MB PSRAM, 1600×1200 RGB565) and the 13.3E6**: a generated
  split of two photos and a clock. With `-d:memProbe`, confirm a partial pass
  allocates nothing canvas-sized, and watch `rhythm:snapshot:refused` on a full
  pass — the transient tier will usually be refused there (a half-canvas cell
  is 1.9 MB against ~3 MB free), which is the designed answer, not a bug.
- [ ] **A deep-sleep battery frame** with a minute clock and a ten-minute
  photo: `rhythm:store` once per photo, `render pass: full (first render) …
  reused …` on the wakes in between, and the wake interval following the clock.
  Time the read-back on SPIFFS vs. the SD card; if SPIFFS reads are slower than
  the fetch they replace, raise `StoredMinSeconds` or make the tier SD-only.
- [ ] **Wall-clock-aligned wake schedule** (`wake_schedule`): the render task
  now aligns to `frameos_nim_wake_cadence()`. Check a minute clock + photo
  wakes on the minute and the photo does not drift.
- [ ] **A Pi with HDMI at 4K**: the output copy is one extra canvas-sized
  memcpy per pass (33 MB). Measure it against a 5 fps clock; if it shows, skip
  the copy when no overlay, flip or rotation is active *and* the driver is
  known not to write to its input.

## Open

- [ ] **A floor per device class.** A 0.2 s child on Spectra 6 refreshes the
  panel back to back forever. Today that is the user's problem, as it is for a
  fast top-level scene. Options: clamp the effective child interval to the
  measured driver time, or warn in the split drawer when a panel's rhythm is
  far below what the frame's panel can show.
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
