# Local assets, caches and network failures — what is still open

What a frame keeps on its own storage (the SD card on a Pi or an ESP32, the
`/state` partition on an ESP32 without a card), what it does with it when the
network or an API is gone, and what that costs when the source is a paid API.
Written to be read cold: each section says what exists before it says what is
missing. **When an item ships, delete it.** The user-facing "something is
wrong" surface (a status bar / banner system) is a separate track and is
deliberately NOT designed here; this file only makes sure the runtime records
what that surface will need.

Plan written 2026-10-16.

---

## What exists today

**Node cache, stale fallback and the node store** (shipped 2026-10-16).
A node's `cache` takes `staleEnabled` + `staleDuration`: when a refresh fails
(the node throws) or runs on zero-filled inputs, `withCache`
(`interpreter.nim`) serves the stored value for the same inputs while it is
younger than the window, logging `interpreter:cache:stale` with its age.
Cached values that are not images, and every node's `frameos.remember`
values, are kept on storage, one file per node
(`frameos/node_store.nim`: `./state/node-cache` on Linux, `/state/nc` on the
ESP32, nothing in the wasm preview), so they outlive a restart, a scene
reload and an ESP32's deep sleep. A stored entry carries a fingerprint of
the runtime version, the node, its app's sources and the frame geometry; a
remembered set carries the app's sources. Files of uninstalled scenes are
swept when a runtime installs its scene set. The weather and OpenAI text
apps throw on a failed fetch (they used to return the error as the value,
which the cache then kept); the network apps' `config.json` cache blocks and
the Weather and Haiku samples carry a stale window.

**Saving downloaded images.** `frameos.fetchImage(url, { saveAsset: { name,
extension, mode } })` tees the downloaded bytes to
`<assets>/saved/<app>[/<node name>]/<name>.<md5>.<ext>` (`apps.nim`
`saveAsset`, `savedAssetDir`). `mode: "auto"` follows the frame setting
`save_assets` (a bool, or `{appKeyword: bool}`; the workspace calls it "Save
downloaded images as assets"); `"always"` ignores it. Five repo apps carry a
`saveAssets` field: `unsplash`, `openaiImage`, `immich`, `googlePhotos`,
`wikicommons`. `frameOSGallery` and `photoAlbum` do not save.

- New frames are created with `save_assets=True` (`backend/app/models/frame.py`,
  `new_frame`), so every Pi saves by default.
- There is **no cap and no pruning**. The md5 is of the bytes, so the same
  prompt writes a new file per generation; the only guard is "refuse below
  100 MB free". A frame on the Unsplash sample at 10 minutes per photo writes
  ~50 MB a day, forever.
- **Nothing reads `saved/` back.** Not the five apps, not the interpreter,
  not the cache. The folder exists for the owner to browse in the Assets
  panel, or to point a `data/localImage` node at by hand.
- **The ESP32 never saves.** Its downloads stream from the socket into the
  canvas (or sit in a PSRAM/`/state` spill the decoder consumes) and
  `fetchImage` returns `data = ""` on embedded by design (`image.nim`,
  `downloadImageFromResolvedBuffer`), so `saveAsset` is a no-op and `savedAs`
  is never set. An SD card is optional on an ESP32 (`assets_sd_pins` in the
  provisioning config; `fos_assets_available()` is "SD mounted").

**Images and the stale fallback.** A cached image is served stale only from
memory or from the cache's disk tier (`.cache` spill files), and neither
survives a restart: spill files are swept at boot, and the node store keeps
no pixels. On an ESP32 most photo producers draw straight into the canvas,
which the cache never holds ("value aliases the live canvas"), so a photo
scene there has nothing to fall back on. Item 2 below is the answer.

**Connectivity** (`network_state.nim`): the last internet check's
`{status, detail, checkedAt}` behind a lock, written by the main thread's
`checkNetwork` and read by the status screen. Apps and the interpreter do
not see it; nothing distinguishes "the API is down" from "there is no
network" in a scene.

**The bird field journal** is a store scene (`bird-field-journal`, store
version 5, 138 installs, minimum FrameOS 2026.7.5), not a repo app: its JS
app `birdJournal` lives inline in the scene's `apps` map. It is the one
scene that reads back what it wrote: plates go to
`writeAsset("birdJournal/<taxon>-<slug>.png")`, the species log is a
disk-persisted json state field, renders cycle the plates with
`loadAssetImage` by a cursor, and `maxSpecies` 24 prunes (and deletes) the
least recently seen. Cost shape: a plate is one `gpt-5.1` Responses call with
the `image_generation` tool (quality medium) plus one vision verification
call, after downloading two reference photos; it draws **one plate per
render and sets `setNextSleep(20)` while any are pending**, so a fresh
install in a birdy place draws its whole backlog (up to 24 species, 3
attempts each) in a burst, and a species the model keeps failing costs
three plates and three verifications back to back. It cannot run on an
ESP32 as written: reference photos come into the JS heap as base64
(`httpRequest(..., { base64: true })`), the generated PNG arrives as a
base64 string inside the Responses JSON (a 1024² PNG is one to two MB of JS
string), `writeAsset` needs an SD card, and `loadAssetImage` decodes the
plate at native size.

---

## The design

Four rules.

1. **One mechanism, in the runtime, not a pattern every app copies.** The
   interpreter and the `frameos` bridge own "keep what you fetched" and
   "what to do when the fetch fails"; an app or node opts in with one
   option. The same code runs on the Pi, the ESP32 and the wasm preview.
2. **Stale is explicit and bounded.** A reused value always carries its age,
   the author says how old is still acceptable, and past that the failure
   shows as it does today. The runtime records every stale serve so the
   later status surface can say "weather as of 09:40, no internet".
3. **Every local store has a cap** (count or bytes), evicts oldest first and
   degrades to "no store" rather than filling the card or the `/state`
   partition.
4. **Generators are libraries.** A paid source (OpenAI) fills a bounded
   library at a declared rate and the frame rotates through it; it never
   generates per render by accident, and it never generates when it cannot
   store the result.

### 1. Serve stale: what is left

- [ ] **`haSensor` returns `{ error }` as its value** for a failed fetch
  (and for missing settings). Its default cache has no stale window, on
  purpose, but a 60 s cache still keeps the error reply as data. Throw on a
  failed fetch like `weather` does; keep the settings replies.
- [ ] **Store-scene copies.** The published store versions of the Weather,
  Haiku and photo samples still embed the old app copies and caches; the
  repo samples are updated. Republish them, or let the update banner
  (`docs/scene-update-available` flow) carry it.

### 2. Keep and reuse: a bounded image library per node (images: Unsplash, OpenAI, Immich, Google Photos, Wikimedia)

Replace the write-only `saveAsset` tee with a library the runtime also reads.

- [ ] **`saved/<app>/<node>/` gets an index and a cap.** `index.json` next
  to the files: `[{ file, bytes, savedAt, meta }]`, newest first; `meta` is
  what the app passes (prompt, author, source URL, photo id). On every save:
  append, then evict the oldest beyond `max` files (and beyond a byte
  budget). The frame setting `save_assets` becomes **"Keep downloaded
  images: last N per node"** with N = 20 by default (bool/map shape kept for
  compatibility, plus a new `saved_images_max` integer on the frame; a
  node's own `keepMax` field overrides). Adopt the existing flat folders on
  first write: files without an index entry are indexed by mtime and pruned
  like the rest, so the unbounded folders on every Pi shrink to N on the
  next save. Both control planes: `docs/cloud-frames-contract.json` +
  generator, the backend column + alembic, the SPA key lists
  (`frameLogic.ts` incl. `FRAME_KEY_INTRODUCED_FRAMEOS_VERSION`, the
  settings nav in `FrameWorkspace.tsx`), the cloud's `frameDiffKeys()`,
  `embedded_render.py` (`saveAssetsJson`), the wasm preview's
  `saveAssets` plumbing (`wasm_main.nim`).
- [ ] **`fetchImage` option `fallback: "kept"`** (name TBD; `keep` replaces
  `saveAsset` and takes `{ name, extension, mode, max, meta }`; `saveAsset`
  stays as an alias). When the download or decode fails and the node's
  library has entries, return `{ image, kept: true, keptAt, meta }` for the
  newest entry not shown last (round-robin over the library, position in
  the node's memory) instead of `{ image: null, error }`; log
  `image:kept` with the error; record in the ledger. The five apps pass
  their metadata as `meta` and, when `kept` comes back, write that meta to
  `metadataStateKey` so captions stay truthful ("Photo by …" matches the
  photo). Declarations in `appTypeDeclarations.ts`, mocks in the app test
  harness (`mock.fetchImage` learns `kept`), per-app `app.test.ts` cases,
  `test_<app>_js_app.nim`.
- [ ] **`frameos.keptImages()`** for apps that want their own policy: the
  index of this node's library, `[{ path, savedAt, meta }]`, newest first,
  and `loadAssetImage(path)` to show one (already exists; make it honour the
  planner's decode target like `fetchImage` does, so a kept photo streams
  into the canvas on an ESP32 instead of decoding at native size — the spill
  decoder `decodeSpilledImageInto` already reads a file into a target).
- [ ] **ESP32: keep on the SD card.** The streaming decode gets a tee: while
  `downloadImageStreamingInto` consumes the socket, write the bytes to
  `<sd>/saved/.../<name>.part` and rename on a successful decode; the
  buffered paths write `response.body`/chunks/spill the same way. Without a
  mounted card the `keep` option is a no-op logged once per boot. The
  library read side needs nothing new beyond the item above. ESP-IDF
  firmware is a CI round-trip per change; the Nim side (`image.nim`
  embedded branches) is where the tee lives, and
  `docs/esp32-memory.md` gets the measured cost of the extra write per
  render on the bench frame.
- [ ] **Assets panel**: `saved/` folders show their cap and "kept by
  <scene> / <node>" from the index; "Clear" per folder. Both planes share
  the SPA, so this is one change.

### 3. Generators rotate: OpenAI image as a library with a budget

- [ ] **`openaiImage` gets `library` and `newImageEvery`.** `library`: how
  many generations to keep (default 20, through item 2's cap). `newImageEvery`:
  `every render` (today), `hourly`, `every 6 hours`, `daily`, `never (rotate
  what is kept)`. Logic: if the library has fewer than `library` images, or
  the newest is older than `newImageEvery`, generate (and keep); otherwise
  return the next kept image (round-robin or random, a `rotation` select).
  A failed generation (quota, 5xx, no network) falls back to the library
  through item 2 instead of an error frame; an empty library keeps today's
  error. Generation is skipped when the result cannot be kept (no card on an
  ESP32, low disk) only if `newImageEvery` is not `every render` — an owner
  who asked for a fresh image per render still gets one. The spend ceiling
  is then readable from the node: at most one generation per
  `newImageEvery`.
- [ ] **Sample + store scene "OpenAI image"**: default `newImageEvery =
  every 6 hours`, `library = 20`, refresh 3600 s stays (the frame rotates
  through kept images between generations). Note the behaviour change in the
  scene's description; frames on the old version keep their scene until the
  owner takes the update.
- [ ] **Same shape for `openaiText`** (a haiku per render today): a
  `library` of kept texts in the node's remembered values (persisted since
  2026-10-16), `newEvery`.
- [ ] **Scene guide**: a "Paid sources" paragraph — generate at a declared
  rate, keep a library, fall back to it, never generate what you cannot
  store; the AI scene builder reads it (run the evals).

### 4. Record what the status surface will need (no UI here)

- [ ] **A per-scene freshness ledger** in the runtime, values only, behind a
  lock like `render_stats`/`network_state`: per node `{ lastSuccessAt,
  lastError, staleSince, keptSince }`, updated by `withCache` (today it only
  logs `interpreter:cache:stale`) and the kept fallback (item 2). Exposed
  read-only over the admin API (`/api/...` on the Pi, the ESP32's status
  JSON) and to scenes as `frameos.freshness()` so a code node can already
  draw "as of 09:40" if it wants to. The later banner system reads this plus
  `lastNetworkCheck()`; nothing else is designed now.
- [ ] **Distinguish "no network" from "that API failed"** in the error the
  ledger keeps: the HTTP layer already knows (DNS/connect vs HTTP status);
  `httpRequest`/`fetchImage` errors get a stable `kind` (`offline`,
  `timeout`, `http`, `decode`) next to the message. `network_state` is
  refreshed by the same failures so the status screen is not waiting for
  the periodic check.

### 5. The bird field journal: cap the bill, say no to the ESP32

The scene is the store's (`bird-field-journal`); the work is a new store
version, published from the account that owns it.

- [ ] **Budget, not backlog.** Replace "one plate per render, 20 s apart
  until done" with: `platesPerDay` (default 4) and `minutesBetweenPlates`
  (default 60), counted in the journal state (survives sleep); the backlog
  waits its turn and the caption says "3 species waiting". Retries back off
  (1 h, 6 h, 24 h, then give up) instead of three in a row. Verification
  stays on by default; the scene description states what a plate costs with
  it. The plates use item 2's library (`keep` with `meta = species`) instead
  of a private folder once that ships, so pruning, the panel and the
  fallback are shared.
- [ ] **Tests with the next version.** An `app.test.ts` for the inline app
  (the JS app harness runs a scene's own apps too, or the app moves to
  `repo/apps/image/birdJournal` as a template the store scene copies),
  mocking iNaturalist, the Responses API and the photo bytes.
- [ ] **Refuse the ESP32 cleanly.** `app.frame.embedded` → return a panel
  "The bird field journal needs a Raspberry Pi frame" instead of an OOM. A
  catalog flag (`config.json` `hosts: ["linux"]` or the existing minimum
  version mechanism extended with a target) so the store, the AI builder
  and the install flow say so before install. If an ESP32 port is ever
  wanted it needs one new primitive: **`httpRequest(url, { toAsset: path })`
  — download straight to the card without passing through the JS heap** —
  for the reference photos and the Responses body, plus a streaming base64
  extraction of the plate from that body; that primitive is worth building
  on its own (it is also item 2's "keep" for any `httpRequest`), the
  journal port is not.

---

## Order of work

1. Item 2 on hosts (index + cap + `fallback: "kept"` + the frame setting on
   both planes). Stops the unbounded `saved/` growth every default Pi has
   today, and gives the five photo apps an offline answer.
2. Item 3 (OpenAI library + rate). Depends on 2.
3. Item 4 (ledger + error kinds). Small; do it alongside 2 so the events
   exist from the start.
4. Item 2's ESP32 tee. Firmware CI round-trips; bench on the E1002 and the
   E1004 (`docs/manual-testing-todo.md` gets the box).
5. Item 5 (bird journal). Independent of the rest except for using item 2's
   library.

Open decisions for the owner, in one place:

- Default N for the library (20?) and whether the frame setting default
  stays "keep" (it is `True` for new frames today).
- The OpenAI sample's new default rate (every 6 h?) — a change for anyone
  who updates the scene.
- Bird journal daily budget default (4 plates/day?).
