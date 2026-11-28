# FrameOS Repository Guide

## Project overview
- FrameOS is an "operating system for single-function smart frames" designed to run on Raspberry Pi–class hardware with a mix of e-ink and standard displays. The ecosystem includes a backend control plane, a frontend web UI, and firmware/runtime components for the frames themselves. 【F:README.md†L1-L40】
- Typical usage: run the backend service to manage frames, configure hardware-specific scenes, and deploy code or prebuilt scenes to devices over SSH.

## Cloud/backend parity (working rule)
- There are TWO control planes for frames: the self-hosted backend (`backend/` + `frontend/`) and FrameOS Cloud (`cloud/` + `cloud-frontend/`). **Any frame-facing feature or fix must land on both, or explicitly note why it's one-sided** — unless the task says otherwise. When you touch frame panels, frame APIs, device verbs, or provisioning/flashing, check the other control plane before calling the work done. Neither plane builds ESP32 firmware: both flash the signed generic release image, provision over the USB console, and offer the release OTA (`docs/todo.md`, `embedded/esp32/README.md`).
- The frame workspace UI is SHARED code (`frontend/src`), wrapped for cloud by `cloud-frontend/`. A fix that "doesn't show on cloud" is usually NOT a fork — check the `workspaceSurfaces` gating (`frontend/src/scenes/workspace/`) and remember the cloud serves a PREBUILT bundle: auth-web's predev rebuilds it via turbo (`scripts/build-frames-app.mjs`), but a long-running `pnpm dev` session keeps serving the bundle from its start.

## The iOS app: `docs/ios-app.md`

- `ios/` is a native SwiftUI client of BOTH planes (`FrameOSKit`: the
  transport, the contract readers, one service per workspace area;
  `FrameOSUI`: the screens). It calls the routes the SPA calls, through
  `APIClient` (its `apiFetch`: project scoping on a backend, `Origin` on the
  cloud), and never gets a route of its own. A change to a frame-facing
  route or payload checks `ios/FrameOSKit/Sources/FrameOSKit/Services/` too.
- What the SPA decides in shared code the app never hand-copies: it is
  generated (`generate_deploy_progress_contract.py` and
  `generate_cloud_contract.py` write Swift tables, under the backend suite's
  `--check`) or pinned by a corpus both replay —
  `docs/frame-status-fixtures.json` (`decorators/frame.tsx`),
  `scene-form-fixtures.json` (`refreshInterval.ts`, `showIf.ts`),
  `button-map-fixtures.json` (`frameEventMap.ts`), `api-path-fixtures.json`
  (`projectApi.ts`), `server-address-fixtures.json`,
  `render-on-server-fixtures.json` (`renderOnServer.ts`). Change the SPA
  function, its Swift port and the corpus together; the SPA's runners are
  `cloud/apps/auth-web/src/test/shared-spa/*-fixtures.test.ts`.
- A backend's scene and album installs are its own MCP tools
  (`frame_scene_install`, `photo_album_install`): keep their arguments.
- `ios/bin/test` and `ios/bin/check-ui` run without Xcode; the **iOS app**
  workflow (`.github/workflows/ios.yml`) builds for the simulator.

## Tests: CI is the gate, and you watch it

- **You do not have to finish every local suite before opening a PR.** CI runs
  them all anyway and is often faster than a laptop. Run what is quick and
  covers what you touched, open the PR, then **watch CI to the end** (`gh pr
  checks <n> --watch`) and fix what it reports. The work is done when CI is
  green, not when the PR is open: a PR nobody watched is how the cloud job came
  to be failing "all the time". This holds for every suite, the Nim shards and
  the firmware image included.
- **A pull request skips the heavy jobs it provably cannot affect**
  (`.github/ci/changed_areas.py`, the `changes` job of `pull-request-tests.yml`
  and `e2e-docker.yml`): a cloud-only change runs no Nim shards, an iOS-only
  one no Playwright. Every path is relevant unless a rule there says why not,
  so a test that starts reading files of another area (a Nim test reading
  `backend/`, Playwright reading `cloud/`) must take that area off its
  irrelevant list in the same change, or it is skipped for exactly the pull
  requests that break it. Pushes to main run everything. The jobs run on the
  monster pool's 16-core slots from a warm nightly image
  (`tools/gha-runners/README.md`); a full pull request is about five minutes.
- **What to run first under `cloud/`, `cloud-frontend/` OR `frontend/src`** —
  including a test file under `cloud/apps/auth-web/src/test/shared-spa/` — is
  `pnpm verify` from `cloud/` when it is quicker than a CI round trip, reading
  its summary. One vitest file, or the frontend's `tsc`, is not the same check:
  `verify` runs lint + **typecheck** + test + build for every cloud package, and
  the auth-web typecheck covers the shared-spa test files themselves (a fixture
  that vitest happily executed failed `tsc` in CI on 2026-09-12, PR #485) and
  the whole shared SPA the cloud bundle is built from. The frontend's own `tsc`
  does NOT cover it: the cloud has its own tsconfig and build.
- Cloud CI (`.github/workflows/cloud-ci.yml`) is **`verify`**, which runs
  `turbo run lint typecheck test build --filter='@frameos-cloud/*' --filter=@frameos/cloud-frontend`, and beside it
  **`integration`**: THREE integration suites against a real Postgres, one
  per leg (auth-web's in three shards): `@frameos-cloud/auth-web`,
  `@frameos-cloud/frame-hub` and `@frameos-cloud/ledger` (the accounting
  kernel — the module whose own todo records a shipped billing bypass, so do
  not skip it). Deploy waits for both. A green `pnpm test` alone proves little, because the integration
  suites are where the interesting failures live. To run them locally, from
  `cloud/`:

  ```
  pnpm verify
  pnpm --filter @frameos-cloud/auth-web test:integration
  pnpm --filter @frameos-cloud/frame-hub test:integration
  pnpm --filter @frameos-cloud/ledger test:integration
  ```

- **Never run two copies of one integration suite at once.** All of a suite's
  files share ONE database and truncate between files (`fileParallelism: false`
  exists for exactly this), so a background loop plus a foreground run will
  produce unrelated "failures" in both. The two suites use different databases
  and may run side by side. If tests you did not touch fail, check what else
  was running before you believe the result.
- **A `verify` failure is often not a type error.** Read the log before
  concluding: the frame/device suites drive fake devices over the real command
  queue with `setTimeout` poll loops, so they are timing-sensitive, and a
  loaded CI runner surfaces races that a developer laptop never does — the
  chunked-upload assertion in `frame-assets.integration.test.ts` failed on CI
  and passed 15/15 locally.
- **When one of those races bites, fix what the assertion measures — do not
  add a retry, a sleep, or a widened tolerance.** The pattern that has already
  caught us: asserting on *all* pending commands for a frame when the claim was
  about one verb. Every asset write also queues an `assets_list` refresh, so a
  frame legitimately has unrelated commands in flight; count per type
  (`fakeDevice().maxPendingOfType(...)`) and record which commands were in
  flight together, so the next failure explains itself instead of printing
  `expected 2 to be 1`.

## A scene runs as a compiled program: `docs/scene-compiler.md`

- `frameos/src/frameos/scene_compiler.nim` turns a scene's nodes and edges
  into one JavaScript program when the scene first starts (on the device,
  every host; scenes.json is unchanged). `interpreter.nim` keeps the hosting
  (layouts, holes, rhythm, pointer routing, press maps) and gives the program
  its natives (`programOp`): node ids and handles to the scene's `Value`s in,
  so a value reaches an app exactly as an app made it. A new node type or edge
  kind is a case in the compiler and, if it needs Nim, a native; never a walk
  of the graph at run time. A scene with code of its own runs in a QuickJS
  runtime of its own where there is room (a Pi, an ESP32 with more than 8 MB
  of PSRAM: one scene running out of memory takes no other with it), and in a
  realm of its own in one shared runtime on an 8 MB board
  (`js_runtime/runtime.nim` `ensureSceneJs`); scenes without code share that
  runtime's first context. A scene's JS apps run in that same context,
  beside its program and each other (one QuickJS a scene, never one an app
  node: 155 KB of PSRAM each on an ESP32), so a scene with JS apps counts as
  one with code; each app is a module under its own prefix and an entry in
  the app prelude's `__frameosApps` (`app_runtime.ensureReady`), and its
  interpreter going is its scene's context going. What every
  program has in common is not in the program: it is the kit
  (`ProgramKit`), evaluated once per context (`programKit`; bytecode in the
  ESP32 image via `tools/prelude_bytecode.nim`) and handed to each program.
  A helper the glue needs goes there, not into each program's text, which
  the device parses at every scene start.
  Seven small built-in apps (`ProgramApps`: ifElse, setAsState, log,
  parseJson, …) are no Nim app on a frame: the program runs them as
  JavaScript (`"program": true` in their config.json keeps them out of the
  registry; doc section "Program apps"). Their Nim modules stay for compiled
  scenes.

## Scene events: the contract is `docs/events-contract.json`

- Event names, payloads, who may emit what (`origins`, an allow-list), the log
  / coalesce / render-after policy and which host has an event all live in
  **`docs/events-contract.json`**; `docs/events.md` is the prose and
  `docs/event-fixtures.json` the conformance corpus. **Never add an event name
  to a list of your own** — not in Nim, C, TypeScript or Python. Edit the
  contract, run `python3 frameos/tools/generate_events_contract.py`, add a
  fixture. `frontend/schema/events.json` is one of the generated files.
- The generator's `--check` runs in the backend test suite
  (`test_esp32_events_contract.py`), so a stale table is a red PR. The fixture
  runners are listed at the top of `docs/events.md`; the Nim one is
  `frameos/src/frameos/tests/test_event_fixtures.nim`.
- Both control planes read the same tables (the backend's
  `events_contract_gen.py`, the cloud's `events-contract.gen.ts`): an event the
  cloud should be able to send needs a `cloud.verb` in the contract, not a new
  `case` alone.
- A scene's own code sends events through one door, `dispatchFromScene`
  (`js_runtime/app_runtime.nim`): the `dispatch` node and `frameos.dispatch`.
  It owns the origin check, the render-during-render guard and the budget.
- **One dispatcher, `frameos/src/frameos/event_loop.nim`, for Linux, the ESP32
  and the wasm preview.** It owns the queue, the origin allow-list, the
  command/event split and the render rule (`renderAfter`); a host supplies an
  `EventHost` and no opinions. `sendEvent(event, payload, origin)` has no
  default origin on purpose: the producer's entry point says who is talking
  (`eoHttpWrite`, `eoSchedule`, `eoCloud`, `eoScene`, …), never the payload. Do
  not add a `case event` to a host — add a contract column, or a callback to
  `EventHost`. The ESP32 runtime and the wasm preview share their host
  (`frameos/single_scene_host.nim`: scene lifetime, lifecycle events, the
  EventHost): a fix there is a fix for both, and a copy in either file is how
  the two drift. wasm does not trap on a nil dereference (address 1 is
  readable) — a green preview check says nothing about one. On the ESP32 the C edge is `embedded/esp32/main/fos_events.c`
  (one function for HTTP, schedule, cloud, console and buttons), and scene
  code runs on the render task alone: what reaches the Nim dispatcher from
  any other task (HTTP, the cloud, the console) is queued for it
  (`fos_events_defer`) — the first HTTP `pointerMove` compiled the scene's JS
  on the 8 KB HTTP task and crashed the frame (2026-10-26). New behaviour
  gets a case in the `dispatcher` section of `docs/event-fixtures.json`
  (`test_event_loop.nim` runs it). **Input** (pointers, keys, buttons) goes
  through `frameos/src/frameos/input_state.nim` — the cursor, the modifiers,
  the keyboard layout, the gestures, the button holds — and reaches a scene only
  under the names it listens for, old names (`mouseMove`) included as contract
  aliases; the driver side is a struct (`driver_abi.nim`), never JSON per motion
  report. The ESP32 compiles the pointer and gesture half too (the reTerminal
  Sticky's and the E1003's GT911 glass, `embedded/esp32/main/fos_touch.c`, queues
  `pointerDown` / `pointerMove` / `pointerUp` on the wire and the render task
  delivers them) and the old-name aliases with them, not the keyboard half. `docs/events.md` "Input" is the spec; `test_input_state.nim` and the
  evdev translator's `test_translate.nim` are where a rule gets its test.
  A JS app subscribes in its `config.json` (`events`, `"*"` per the contract's
  `heardByAll`) and hears through `onEvent`: `eventApps` beside `eventListeners`,
  so `sceneListensTo` stays a question no JavaScript answers.

- **Two event maps, one rule shape** (`docs/events.md` "Event map";
  `event_map.nim`, applied by `event_loop.nim` on every host). The
  **frame's** (frame.json `eventMap`; `event_map` as a frame column, a cloud
  `set_settings` key and an ESP32 NVS slot; "Button actions" in Settings,
  `utils/frameEventMap.ts`) binds a key to the frame whatever scene shows —
  a rule with `emit` replaces the press (origin `eventMap`), the scene never
  hears it; every hardware preset's map is the button standard's
  (docs/buttons.md, below), never written by hand. A Linux frame never given
  a map runs its device's:
  every HyperPixel's left/right edge swipe is `back`/`forward` (the scene's
  own, never a scene switch), up from the bottom
  the scene switcher and down from the top the settings (as the SenseCAP
  preset does), every Inky Impression's A to D the standard's
  (`frameos/device_event_map.nim` and the SPA's `deviceEventMap`, pinned
  together by `device-event-map.test.ts`). `setCurrentScene {direction}` is resolved by the
  dispatcher from the host's `sceneOrder`, never by a host. **An installed
  scene's** map is the install's, never the scene's: `eventMap` beside
  `nodes`, the backend keeps it on the `frame.scenes` entry (the MCP
  `frame_scene_update` carries it over), the cloud on the assignment row
  (`event_maps`, by runtime scene id; `scene-event-map.ts` stamps it into
  the push), the SPA strips it with `origin` before any publish
  (`cloudFrameScenesSave.ts`) and templates never carry it; the dialog is
  "Map buttons" in the scene menu (`buttonMapLogic.ts`,
  `utils/sceneEventMap.ts`). A scene update must keep it on both planes.

## Buttons: `docs/buttons.md` is the standard

- Every board's keys play five roles (Action `primary`, Next/Prev, Back,
  Home `menu`, Screen), each a press and a hold, **no double or triple press
  in any default** (two presses are two presses; a press is delivered at its
  `up`, and only a key some rule binds a `doublePress` of waits). Holds are
  the frame's: Action held talks (a microphone) or is Home, the arrows held
  walk the scenes, Back held and a Home key pressed are the scene list, a
  Home key held the scene's settings. A board with no Back key gets one from
  two keys held together (`input_state.nim`, only where a map binds Back by
  role). A key that points somewhere is configured as its direction
  (`left`/`right`/`up`/`down`) and delivered as `next`/`prev` through the
  frame's rotation (`facing`). A `next`/`prev` press no scene hears is its
  `forward`/`back` (`event_loop.nim`).
- **One function makes every preset's map**: `default_event_map` in
  `backend/app/utils/button_standard.py`, from `EMBEDDED_BOARD_KEYS` (every
  key of every preset and its role) in `embedded_firmware.py`.
  `frameos/tools/generate_board_keys.py` writes the copies (the firmware's
  `fos_board_keys_gen.h`, the SPA's `frontend/src/generated/boardKeys.gen.ts`,
  the Linux devices' `device_event_map_gen.nim`); the backend suite runs its
  `--check`. Change a board in the backend and run the generator; never edit a
  copy, and never add a hand-written map. An ESP32 sends each key's role with
  its edges (`fos_board_key_role`). The firmware finds its voice key by label,
  so a voice rule always names a label.

## The scene switcher: `docs/scene-switcher.md`

- `system/sceneSwitcher` (the contract's `scenes.switcher`) is a scene built
  into every runtime, `frameos/src/system/sceneSwitcher/scene.nim`: every
  scene on the frame as a tile. The `sceneSwitcher` scene command opens it
  and the dispatcher resolves it (`event_loop.nim` hands it `state.from`;
  while it or the scene settings show, either command goes back there, but
  its header's gear, `sceneSettings {page: "frame"}`, opens the frame page,
  shown only while the frame offers one, `{swap: true}` the list over a
  scene's settings, and on a desktop the other one always opens beside), never
  a host. An ESP32 that takes taps and on which nothing was ever picked (no
  remembered scene, none marked `default`) starts on it as the frame's home
  (`state.home`: no Close, no timeout, back stays; `fos_boot_scene_home`,
  `openHome`; doc section "The frame's home"). It is drawn
  with the JSX layout from a tree built in Nim (no QuickJS), lists the
  host's scene order through `sceneSwitcherListing`, grouped by category as
  the desktops group theirs, in one list that scrolls (no pages); the Linux
  host still keeps each scene's last snapshot (`sceneSwitcherThumbnail`,
  `frameos/scene_switcher_linux.nim`, no longer drawn); it is a folder's icon
  view (Explorer's, Finder's: an icon over its name, one size, more of them
  in a bigger room, compact category groups: `switcherGrid`), and every
  desktop of windows opens it as its window of every scene, in its theme;
  fast panels get a dark grid, e-paper
  black on white with the keys walking an inverted highlight that the list
  scrolls to.
- Both built-in scenes are drawn in the layout of the scene they were opened
  from (`state.layout` from the dispatcher, `ownRun` / `builtInRunner` into
  `interpreter.runEvent`; `docs/scene-layouts.md`). A new one goes the same way.
- It is never persisted on any host (no `scene.json`, no ESP32 `last_scene`
  or `pending_scene`, no state file) and is in no scene list: test with
  `isBuiltInScene`. `single_scene_host` runs every scene through its export
  (`init` / `runEvent` / `render`), so a built-in scene needs nothing more
  from the ESP32 or the preview, and `fos_scenes.c` applies one without a
  slot. A new built-in scene goes the same way, not into a host.

## Scene icons: `docs/scene-icons.md`

- `settings.icon` is ONE SVG path in a `0 0 24 24` box, filled (nonzero) with
  the color around it, at most 1024 characters: nothing else. What is not an
  icon is no icon, never an error. The rule is `scene_icon.nim` and
  `utils/sceneIcon.ts`, pinned by `docs/scene-icon-fixtures.json`; change the
  two and the corpus together. Every host lists it in `app.frame.scenes`
  through `listingItem` (an ESP32 off its scene index, `make_entry`), and the
  switcher draws it on its tiles. An SVG becomes one path in the editor alone
  (`utils/svgToSceneIcon.ts`), never on a frame.
- `settings.category` is the category's NAME as text ("Photos", "Clocks & time"),
  picked from the store's titles in the editor and listed as `category` the
  same way. Nothing on a frame maps it or checks it: no ids, no table, no rule
  (an ESP32's scene index only keeps one of 128 bytes or fewer, through the
  icon's `keep_text`); the desktops trim it and group by the text itself
  (`grouped`), and a store version whose scene names a store title is filed
  under it. A new repo sample names its category.
- `settings.opens` is the file types a scene opens, their extensions as text
  ("pdf", "txt md json"), listed the same way (`opens`; an ESP32's index keeps
  128 bytes or fewer). The Files app sends such a file to the first scene that
  names its kind as `setCurrentScene {sceneId, state: {file: "<storage>:<path>"}}`:
  a scene that says `opens` has the public field `file` and sets it back to
  "" once open (docs/scene-guide.md, docs/scene-store.md "The Files app").

## Scene settings on the frame: `docs/scene-settings.md`

- `system/sceneSettings` (the contract's `scenes.settings`) is the other
  scene built into every runtime, `frameos/src/system/sceneSettings/scene.nim`:
  the public fields of the scene showing as a form (the JSX layer's fields,
  keyboard on the screen and scrolling list, `docs/jsx-ui.md`). The
  `sceneSettings` command opens it and the dispatcher resolves it like the
  switcher's, handing it `state.from` plus that scene's `fields` and `values`
  read BEFORE the switch (an ESP32 lets the scene go while the panel shows).
  Save is `setCurrentScene {sceneId: from, state}`, which every host already
  applies to public fields; the same command again, or `sceneSwitcher`,
  goes back unsaved.
- Bound to a swipe down from the top in every touch preset, a Home key held,
  and the scene list's gear (docs/buttons.md; the generated maps). Both
  built-in scenes go through `isBuiltInScene`; a third goes the same way.
- A gear left of Save opens the **frame page** (doc section "The frame page"):
  Wi-Fi, rotation, scale, Render again / Restart FrameOS / Reboot (under the
  card), an About card last (what the frame is: the host's `about` facts as
  numbers, every word and unit the scene's; doc section "About"), and on a frame no plane holds Link to cloud / Link to backend beside them:
  one page for FrameOS Cloud (the device flow) or a backend (scope `adopt`,
  exchanged at the frame's `POST /api/adopt`), each its code, a QR code and
  Cancel, the cloud's also its server and a Cloud address to change, and a
  stopped link saying why with Try again, and on a frame a plane holds Unlink,
  asked twice (doc sections "Unlinking" and "Connecting the frame": both codes are presence codes,
  shown on the page, and no picture is kept while one shows; keep the
  Pi's `adopt_routes.nim` and the ESP32's `fos_http.c` alike). The page is
  built in the scene from FACTS a host hands over through three hooks
  (`frameSettingsRead` / `Apply` / `Action`): the ESP32's
  `main/fos_frame_settings.c` (via `embedded_runtime.nim`) and the Pi's
  `frameos/frame_settings_linux.nim` (portal Wi-Fi code on its own thread).
  Words go in the scene, never in a host. Its buttons send the contract's
  device commands from the origin `panel`. A touch frame boots without
  waiting for its network and never opens a hotspot in its scene's place: the
  page is where it joins (doc section "A boot that does not wait for the
  network"). An ESP32's rule is `fos_wake_wifi_plan` (`fos_wake.c`,
  host-tested): the LCDs and the fast e-paper of the Sticky and E1003 join
  behind the scene, a sleeping e-paper board's timer wake holds its one render
  for the join until a touch or 45 s, and one with no network saved and no
  scene opens on the page. A Pi's is `boot_network.nim`: a HyperPixel checks
  the network behind its scene, unless its frame says `networkCheckOnTouch`.
  **No plane is ever told the Wi-Fi network** (a
  backend learns the address alone); rotation and scale set there are ADOPTED
  by the plane: the cloud mirror follows `hardware.rotate` / `renderScale`,
  a backend the `settings:frame` log line (`frame_settings_adopt.py`). The
  plane can turn the page off (`frame_settings_on_screen`); the device keeps
  the last word (a Pi's `frameos-settings-unlock` file on the boot partition,
  an ESP32's `set settings_unlock 1`). Its **Service keys** page (doc section
  of that name) is where a key is typed on the frame: the frame's own (a Pi's
  `state/service_keys.json`, an ESP32's NVS `svc_typed`), never told to a
  plane, and over the plane's field by field where `jsGetSetting` reads them
  (`frame_service_keys.nim` `withServiceKeys`): a new reader of service keys
  goes through it.
- On a desktop (`builtInScenesStay`: the windows of a Pi, an ESP32 or the
  browser) every scene's settings are an instance of their own,
  `system/sceneSettings#<scene id>` (contract `scenes.settingsWindow`,
  `event_loop.settingsWindows`), and the plain id is the frame page's one
  window. A reader of built-in ids asks `isBuiltInScene` / `isSceneSettings`,
  never `== SceneSettingsId`; the firmware's C reads the prefix too
  (`FOS_SCENE_SETTINGS_WINDOW_PREFIX`, `is_built_in_scene` in `fos_scenes.c`).

## Scene previews on a frame: `docs/scene-previews.md`

- A scene a frame shows for now without holding it in its saved or assigned
  list (the editor's "Preview on frame", an ad-hoc `set_scenes` push) is
  reported by both planes as `scene_preview` on the frame while that push is
  the newest scene set, and the scene list draws it as a preview row with
  "Install" and "Discard" (confirmed: a discarded preview is gone for good).
  **A preview rides along**: a scene push without a preview of its own (a
  deploy, the list pushed again) carries the standing preview's scene with
  it, so the frame keeps showing it through pushes and reboots; only a push
  that holds a scene of that id (Install), or a Discard (`DELETE
  …/scene_preview` / `/scene-preview`), ends it. Each plane keeps ONE scene
  bundle per frame (the backend empties older `_preview.scenes`, the cloud
  spends `scenes` on ack); the preview's name, source and shown scene outlive
  the bundle. A new pusher sets `source` and goes through the same two
  routes, never a store of its own.

## The scene store on a frame: `docs/scene-store.md`

- **Scene store** is a scene (`repo/scenes/samples/Scene store`, one JSX app),
  and so is its sibling **Files** (id `asset-browser`). The app has the words and keeps
  where it is in a private disk field (`spot`), so it reopens on the same spot
  after a preview; the host has the facts and does the network off the render
  task: `frameos.store()` / `frameos.storeAction()`
  (`frameos/scene_store_hooks.nim`; `frameos/scene_store_linux.nim` on a worker
  thread, `main/fos_store.c` on the request task, `fos_js_io_run`), and it draws the scene that
  asked again when it is done, if it still shows. A new action is a host's on
  both; a word is the app's. A runtime with no host (a board rendered on its
  plane, a virtual frame) answers null and the app installs nothing. The
  browser preview's host previews and installs nothing
  (`frameos/scene_store_preview.nim`, `previewOnly`): a store scene loads
  beside the page's scenes, and the page's scene select follows the runtime
  (the worker's `sceneInfo`).
- Browsing is the app's own `fetch` of the store's listing for frames
  (`/api/store/device/scenes`, from the host's `url`; 24 a page while it scrolls and a screenful on e-paper, `prefer=fast` / `without=fast,linux`
  from what the scene needs, `frontend/src/utils/sceneNeeds.ts`, never a category). A layout is tried: a `preview` with
  `show: false` and then the frame's own layout choice (`storeAction('layout')`, `app_runtime.nim`); Keep installs it
  around every scene (doc section "Trying a layout"). The store front's first split is Scenes | Layouts; a layout's
  shelf is its kind, never a stated category (`categories.ts`, doc section "Categories"). A change is asked of the frame's plane (`POST
  /api/frames/{id}/panel/scenes`, cloud `panel-scenes.ts`, backend
  `panel_scenes.py`, which a Pi reaches at `/api/panel/scenes`): public store
  scenes only, no service key ever granted, nothing new that asks for a red
  permission (`needs_owner`: the store on a frame shows no tags), refused
  while the settings on the screen are off; `show: false` installs without
  leaving the store. Only a frame with no plane installs by itself. Keep the
  two routes alike. `frameos.storeAction` is for an app whose config.json
  `permissions` has `"store"` (a red tag, detected on save like `"frame"`
  and `"code"`; `storeGrant` in `app_runtime.nim`, one gate for every host).
- **An app's config.json is read one way: `docs/app-config-fixtures.json`.**
  Strict JSON, an object, at most 32 containers deep, or it is no config:
  the runtime gives such an app nothing (`utils/strict_json.nim`; std/json
  alone reads comments and trailing commas, which no plane's parser does),
  and both planes refuse to save, import or publish a scene that carries one
  (`sceneAppConfigProblem` in `utils/sceneAccess.ts`, the backend's
  `utils/app_config.py`). Never read `permissions` or `settings` out of a
  config.json with another parser; the three runners replay the corpus.
- **A store zip's scenes.json is found by one function**, the cloud's
  `src/lib/scene-zip.ts` (the file beside the shallowest template.json): the
  checks at publish and every reader of a stored zip. A new reader goes
  through it, never its own walk of the entries.

## The terminal: `docs/terminal.md`

- **Terminal** is a scene (`repo/scenes/samples/Terminal app`, id
  `terminal-app`, one JSX app), not a built-in: the commands and their words
  are the app's. It stands on ONE native, `frameos.frame(op, arg)`
  (`jsFrame` in `js_runtime/app_runtime.nim`): the frame page's hooks
  (`frameos/frame_settings_hooks.nim`), so it can do what the page can and
  nothing more. A new power is a hook the frame page has too, never a second
  door. Flash is the budget: the bridge is about 1.3 KB on the ESP32 image.
- Only an app whose config.json `permissions` has `"frame"` (detected from
  `frameos.frame(` on save, `utils/sceneAccess.ts`, a red tag), and only while
  the frame offers its page. The desktops find it like the store
  (`appIs('terminal-app', 'terminal')`): keep the four alike.

## The code editor: `docs/code-editor.md`

- **Code editor** is a scene (`repo/scenes/samples/Code editor`, id
  `code-editor`, one JSX app): a scene's files (scene.json, each app's files,
  each code node's code) read and changed on the frame, and the plane's scene
  AI asked for a draft. It stands on ONE native, `frameos.code(op, arg)`
  (`jsCode`; hooks in `frameos/scene_code_hooks.nim`, hosts
  `scene_code_linux.nim`, `main/fos_code.c`, `scene_code_preview.nim`), only
  for an app whose `permissions` has `"code"` (red tag, detected from
  `frameos.code(`) and only while the frame offers its page. The scene
  settings' Code button opens it on a scene (its public field `open`).
  It also opens a folder of the frame's storages (Open folder: the tree,
  any text file read and saved) through the asset calls alone, under
  `"assets-write"`, which works where the scenes are off: never a
  `frameos.code` op for files.
  A file is a virtualized list built from the JSX layer alone (doc section
  "The file open"): a box that scrolls, as tall as the file, holding only the
  lines around `scrollTop` as one `<textarea>` colored by its `<span>`s,
  slid by `onScroll` one end at a time so the field keeps its caret, its
  wrapped rows measured by `frameos.measureText` (the field's own
  typesetting) so the line numbers and spacers are exact. A
  feature it needs from the runtime is a JSX feature for every app
  (`docs/jsx-ui.md`), never an editor native.
- The plane's half is `POST …/panel/code` (backend `panel_code.py`, cloud
  `panel-code.ts`): `ask` is the voice chat's scene builder asked `typed`
  and saves nothing; `save` never widens what the scene may do (`needs_owner`:
  the permissions and settings its apps declare against the saved scene's).
  Keep the two routes and their codes alike.

## The ESP32 image's size: `docs/esp32-image-size.md`

- Flash is the budget (the 8 MB layout's 3520 KB OTA slot), and every cut is
  in that doc with what it measured: read it before proposing one, and add
  to it. Three decisions stand: QuickJS keeps its Unicode tables and its
  built-ins (Atomics, Proxy, the ES2025 additions: measured 2026-11-24 and
  kept), and a Defect stays catchable (no `--panics:on`): with the desktops
  a failed node must not take the other windows with it.
- **Where an object stands is `embedded/esp32/link_order.txt`** (S3): callers
  near what they call, because a `CALL8` is 3 bytes and reaches 512 KB and a
  longer call is 6. A new module needs no line (the file's `*` stands for
  it). `ci_build_image.sh` prints how many calls a build left long
  (`link_order: ...`); when that climbs, or before a release, run
  `tools/link_order.py optimize --build-dir <build> --out link_order.txt`
  on a finished build and commit the file. Stale costs bytes, never
  correctness.
- The image is assembled and linked without branch-target alignment
  (`-mno-target-align`, `--size-opt`); the modules at -O2 because their loops
  are the frame rate keep the assembler's (`FRAMEOS_NIM_HOT_MODULES`,
  `quickjs_hot.c`). A module that becomes hot goes on that list, and the PR
  says what it cost.
- `build_nim.sh` drops the error check Nim writes after a call that cannot
  raise (`drop_nim_dead_checks.py`: a proc that reaches a raise, an indirect
  call or unknown C is never clean) and folds what Nim writes once per C
  file: inline helpers (`fold_nim_inlines.py`) and string literals
  (`fold_nim_strings.py`). The archive's byte-identical functions (hooks of
  same-shaped types, generics per module) fold after it is made
  (`fold_identical_code.py`, the hot modules kept), and the vendored e-paper
  drivers' identical helpers at the copy step (`fold_panel_helpers.py`).
  A function whose address is compared, or that something outside the
  archive names, must stay out of the fold: the tool refuses any use that is
  not a call or a Nim type descriptor's.
- newlib's formatter and scanner are not in the image: the `printf` family
  is `fos_printf.c` (doubles through QuickJS's `js_dtoa`) and `sscanf` /
  `siscanf` are `fos_sscanf.c`, both `--wrap`s, both byte for byte newlib's
  (`test_fos_printf.c`, `test_fos_sscanf.c`; newlib under QEMU is the
  oracle, doc "Tools for the next pass"). A new conversion goes in them and
  their tests. The shell's C calls ROM and IRAM through flash veneers
  (`main/fos_veneers.h`): a file with `IRAM_ATTR` code stays out of it
  (`test_esp32_veneers.py`).

## One scene at a time on the ESP32: `embedded/esp32/README.md` "Scene storage"

- The firmware keeps one file per scene (`main/fos_scene_store.c`, pure, host
  test `test_fos_scene_store.c`), and a scene can be read, added, replaced or
  removed alone over USB (`usb_api scene-*`), HTTP (`/api/frames/<id>/scenes`)
  and from a control plane. `scene-list` / `GET .../scenes` / `hardware.storage`
  / `embedded.storage` report what the partition holds (`stateUsedBytes` of
  `stateTotalBytes`, `scenesBytes`, each scene's footprint in `sceneBytes`,
  all in SPIFFS's page units: `fos_spiffs_footprint.c`), and each scene's `bytes`.
- A changed scene goes to a NEW slot and the index is switched: the render
  task's copy (`s_slots`) stays valid until it re-reads the index and sweeps.
  A reader that is not the render task reads the index on flash under the store
  lock. Never overwrite a slot in place, never unlink one from another task.
  A whole payload is split by the same `fos_scene_store_apply` (`replace_all`),
  so what the index keeps of a scene (`isLayout`, the `default` mark) is decided
  in one place, `make_entry`.
- Both planes send only what changed when they can, and always fall back to
  the whole list: the cloud's `scenes_patch` (the hub decides at send time from
  the row's `scene_hashes`, `lib/scenes-patch.ts`; the queue row stays
  `set_scenes`), a backend's `/embedded/scenes?patch=1` (what it last served
  per frame, in Redis). A device refuses a patch that is not against the set it
  holds (`base_mismatch`), and the plane sends the whole list.
- One cloud message to an ESP32 is 512 KiB at most (`FOS_CLOUD_WS_MAX_MSG`,
  `esp32MaxMessageBytes`); a set is not. A `set_scenes` row whose message
  would be over it goes out in parts (`nextScenesPart` in
  `lib/scenes-patch.ts`, the hub's `scenesPartMessage`; docs/cloud-frames.md
  "A set in parts"): patches of about 256 KiB, each against a checksum of its
  own that the part before left, sent on that part's `scene_ack` (the
  firmware moves the checksum a patch must name when the set is live, not at
  the ack), a `set_scenes` of the scenes that fit first when the frame's set
  is not known. The row is acked once, at the last part, which alone has the
  row's id, checksum, `scene_id` and `state`; the scene on the panel stays
  until then. No firmware side: a change to how the board checks
  `base_checksum` or acks a patch is a change to this. A backend has no such
  cap: the board reads its answer straight into the store.
- "Push & activate" and "Install & activate" are ONE push of that scene: the
  SPA reads back only the assignments that own it (`only` in
  `cloudFrameScenesSave.ts`) and posts `scene_id` + `state` with the list (the
  queued `set_scenes` carries them, never a second command); on a backend the
  switch rides the queue behind a forced pull that still asks for a patch. The
  device writes a change that activates its scene unpaced (`s_store_urgent`).
- **A set is as big as `/state` has room for, in up to 128 scenes** (256 slot
  files, so a change to every scene fits beside the set; the README's "How
  big a set may be"). What is HELD in memory stays 512 KB
  (`SCENES_HELD_MAX_BYTES`: a producer's whole payload, a backend answer in
  blocks); a backend answer over it, or one there was no block for, is read
  straight into slot files no index names (`fos_scene_pieces_read_to`, the
  store's `stage` calls, what the index keeps read off the bytes by
  `fos_scene_meta.c`) and committed as one change on the render task. A new
  way to bring a set in goes through the staging or the one-scene calls,
  never a bigger block. One staging at a time; a staged file is no sweep's
  and no put's. The planes know the slots by the firmware a board runs
  (`esp32_scene_store_slots`, `esp32SceneStoreSlotsFor`): change the header
  and both together.
- Flash is erased before it is written, and finding what to erase must not
  cost a walk of the partition per block: `fos_spiffs_gc.c` walks once, from
  where it stopped. Emptying files is a write a page too: the store task does
  it (`store_sweep_behind`), and every long hold of the store lock lets go
  between files or 16 KB pieces (`between`), because a render reads its scene
  file under that lock.
- A SPIFFS lookup by name (stat/open/remove/rename) is ~0.5 s on the 32 MB
  boards' 24 MB `/state`: the store lists the directory once to learn its slot
  files (never one lookup a slot: 256 of them were two minutes of a boot),
  writes slots straight to their names and the index as a kept copy then in
  place. Remove the index and slots ONLY through the store
  (`fos_scene_store_remove_index` / `_remove_slots`; a wipe calls
  `fos_scene_store_forget`), and never add a stat to a per-change path.

## Voice chat: `docs/voice-chat.md` is the contract

- Holding the voice key — the key whose long press the frame's event map
  binds to `voiceChat`: REFRESH on the reTerminal E1001/E1002/E1003 presets
  (PDM microphone; the E1004 has none), AI (the Action key) on the reTerminal Sticky (PDM
  microphone on the S3's USB pads), the crown (OK) on the Elecrow CrowPanel
  2.01" watch (PDM microphone), KEY1 / BOOT on the Waveshare PhotoPainter
  / 13.3E6 (an ES7210 codec microphone, `fos_codec.c`, whose ES8311 speaker
  plays the buzzer's notes) — streams speech to the frame's control
  plane and runs one turn of the AI chat with the frame in context and only
  the frame-scoped voice tools (`list_scenes`, `activate_scene`,
  `set_scene_state`, `render_now`, `show_image` — a one-picture
  Unsplash/OpenAI preview scene, from the keys the frame already has —
  `create_scene` / `change_scene` — the scene AI as a sub-turn with the
  editor and catalog tools alone, `voice_scene_builder.py` /
  `voice-scene-builder.ts`, its scene rendered in the frame's memory and
  pushed as the preview — and `rotate_frame`), never the MCP tools: a
  frame's token is not the owner's. The turns are ONE conversation per frame:
  every exchange is three chat rows (heard, a `log` row of the tools that
  ran, the reply) and the next turn gets the last six exchanges with their
  age and actions (`voice_history_for_model` / `voiceHistoryForModel`), so a
  follow-up has the scene the previous sentence built to refer to. **What the voice
  chat may do** is the owner's four switches per frame (change settings /
  use installed scenes / create new scenes / access photo albums — all four
  on by default, the third the home of `show_image`; the fourth gates
  `list_albums` and `show_album`, the voice turn's `photo_album_install`):
  plane-side policy, never a firmware key (backend `device_config`
  `voiceChangeSettings` / `voiceUseScenes` / `voiceCreateScenes` /
  `voiceUseAlbums`; cloud `frames.voice_permissions` via
  `POST …/voice/permissions`), enforced where the turn's tool list is built
  (`VOICE_TOOL_PERMISSIONS` / `voiceToolPermissions`), and the controls are
  drawn only on a frame with a microphone (`utils/voiceChat.ts`). The upload route, the
  caps, the prompt, the tool definitions and the progress words (what the
  panel says while a turn runs: the closing chunk answered as NDJSON for a
  frame that asks, docs/voice-chat.md "Progress on the panel") are the same
  on both planes
  (`backend/app/api/embedded_voice.py` + `app/utils/voice_chat.py`;
  `cloud/.../frames/[frameId]/voice/[sessionId]/route.ts` + `src/lib/ai/voice.ts`);
  the backend's test reads the cloud's `voice.ts` and the cloud's unit test
  reads the backend's `voice_chat.py`, so change both or neither. The words
  are the planes', never the firmware's: it draws the text it is sent.
- On the device the binding is read off the map by `fos_voice_binding.c`
  (cJSON, host-tested) and the hold run by `fos_voice_hold.c` (pure,
  host-tested) in the button task — `voiceChat` is the one emit the
  firmware carries out itself: the button task opens the microphone at the
  hold, and the dispatcher, which makes every other key's `longPress` at
  `longPressMs` while it is held, leaves a voice key's to its `up`
  (`event_loop.bound`); the session is `fos_voice.c`, the microphone
  `fos_mic.c`. A voice key's `up` carries `claimed: true`
  (`docs/events-contract.json` `gpio`): the dispatcher makes no `button` of it. `voice_chat` (the
  microphone switch) is an esp32-only contract setting.

## The accelerometer: `docs/accelerometer.md`

- The reTerminal Sticky's LSM6DS3TR-C and the AMOLED 1.75's QMI8658 are read
  by one task (`embedded/esp32/main/fos_imu.c`, the chip's axes turned into
  the panel's by `k_board_axes` or `set imu_axes`), and what the readings mean
  is `fos_motion.c` (pure, `tests/test_fos_motion.c`): gravity along the
  picture for `frameos.accelerometer()` (`app_runtime.accelerometerReader`),
  the input events `tilt`, `flick`, `shake`, `orientation` (device `motion`,
  their numbers the contract's `motion` block: never a threshold of a host's
  own), and the rotation auto-rotate follows. A new gesture is a contract
  event, a case in `fos_motion.c` and a test there, never a scene's polling.
- **Auto-rotate turns the picture live** (`fos_rotation.c`): every reader of
  the picture's orientation in the firmware asks `fos_rotation()`, never
  `config->rotate`, which is the frame's own rotation (reported, adopted,
  restarted on). The render task hands a new one to the runtime between
  renders (`frameos_nim_set_rotation`, `setRuntimeRotation`): a new canvas,
  packer, press map or input geometry that depends on the rotation reads it
  per render, never once at init. `auto_rotate` is an esp32-only contract
  setting on both planes.
- Gestures bind in both event maps like keys (`frameEventMap.ts`,
  `frameHasAccelerometer` in `utils/accelerometer.ts`; never a preset
  default: a frame-map rule takes the gesture from every scene). The store
  tag is `accelerometer` (`utils/sceneNeeds.ts`): it puts a scene first on a
  frame that has one and leaves it out nowhere, so every such scene plays by
  touch, keys or buttons too.

## Home Assistant: `docs/home-assistant.md`

- The self-hosted backend's Home Assistant link is `backend/app/ha/` (one task
  in the arq worker): every frame is an MQTT-discovered device with the SAME
  twelve entities (an image, sensors, a scene `select`, a display `switch`,
  refresh image / re-render / next / previous / restart / reboot `button`s;
  `discovery.py`). **Refresh is not render**: "Refresh image" is the image
  route's pull of what the panel shows (`current_frame_image` in
  `app/api/frames.py`, shared with `GET …/image`), "Re-render" the `render`
  event; one button for both advanced a random-photo scene (#661). The image
  topic gets `fit_image`'s copy (≤1280 px, under 1 MB), never the panel PNG.
  **A scene's settings are the Scene sensor's attributes (the `fields`
  topic), never entities**: one per field of every scene of every frame was
  tried and reverted the day it merged (2026-11-04, thousands of entities).
  What Home Assistant sets comes back over the frame's `set/*`, `press` and
  `command` topics (`commands.py`) and goes through `dispatch_frame_event` in
  `app/api/frames.py`, the frame event route's own dispatcher, so every
  frame kind takes it the way it takes an editor click. A new verb is a
  contract event sent through that function, never a new send path; the
  `command` topic's allow-list is the contract's `http:write` column, and
  parameters travel with the scene (`{"scene", "state"}`) or as
  `setSceneState`. Cloud-only by omission: FrameOS Cloud has no Home
  Assistant link.

## Deploy progress: the contract is `docs/deploy-progress-contract.json`

- Every deploy, update, restart and reboot of a frame, on every frame type and
  on both control planes, keeps ONE record on the frame row
  (`deploy_progress`): its kind, its stage, `at`. The workspace draws the bar
  from it (`frameDeployProgress` in `frontend/src/decorators/frame.tsx`) in
  place of "last seen", and the deploy tile spins on it. `docs/deploy-progress.md`
  is the per-frame-type spec (which kind, which stage, which signal moves it);
  `docs/deploy-progress-fixtures.json` is the corpus the backend
  (`app/utils/deploy_progress.py`) and the cloud (`lib/deploy-progress.ts`)
  both replay.
- **Never decide "how far is this deploy" from `frame.status` or a log
  regex.** A new step is `advance(record, stage)` from the plane that does it;
  a new device signal is a contract `signals` entry plus the stages whose
  `on` table lists it. Edit the contract, run
  `python3 frameos/tools/generate_deploy_progress_contract.py` (the backend
  suite runs `--check`), add a fixture.
- Records move forward only and only on what their current stage lists — that
  is what keeps the old runtime's last `render:done`, or a late ack of an
  older push, from finishing a deploy. Nothing expires a record; readers
  compare `at` with the stage's `staleAfterSeconds`.
- A route starts the record BEFORE it enqueues the job (the worker's first
  step must find it) and fails it when the enqueue throws. On the cloud,
  `enqueueFrameCommand` starts it for `set_scenes`, `notify_update_available`,
  `reboot` and `restart_runtime`; the hub moves it.

## AI scene chat: change the prompt/linter, then run the evals

- The cloud AI (`cloud/apps/auth-web/src/lib/ai/`) builds and edits scenes on
  the frames workspace AND on the scene store (`SceneAiPanel`). Every delivered
  scene passes `scene-lint.ts` (catalog-aware structural lint) before reaching
  the editor. When you touch `prompts.ts`, the linter, the app catalog,
  `docs/scene-guide.md` or `docs/js-apps-and-code-nodes.md`, run the evals against real OpenAI and
  compare with the previous report: `pnpm --filter @frameos-cloud/auth-web
  ai:eval --compare evals/results/<prev>/report.json` (needs the dev server on
  :3000, the local DB filled by `scripts/import-store-scenes.mjs`, and
  `OPENAI_API_KEY`). See `cloud/apps/auth-web/evals/README.md`.
- The chat can see: `render_scene` renders the scene it holds with the
  server's wasm runtime (`scene-render.ts`, as `POST /api/scenes/render`) at
  the client's preview size (`renderSize` in the request) and returns the PNG
  inside the tool result. Renders never carry the account's service keys and
  spend the account's `scenes:render` budget.

## The AI chat is one thing on both planes: `docs/ai-chat.md`

- Every AI chat in the workspace (the frames home's AI box, the box at the
  top of a frame's page, the editors' chat drawer) is ONE agent loop with the SAME
  NDJSON events on both planes: the cloud's `src/lib/ai/loop.ts` and its port
  `backend/app/utils/ai_chat_agent.py`, read by one `chatLogic`. An event,
  rule or editor tool added on one plane is added on the other.
- On an ESP32 frame the render check and `render_scene` run the scene in that
  frame's memory (`esp32DeviceLimits`; `docs/device-limits-fixtures.json`
  pins the TS copy and the Python port), so a scene that would abort the
  device goes back to the model first. `docs/ai-chat.md` "Renders run in the
  frame's memory".
- Its tools are its plane's MCP tools, run in-process with the chat request's
  own credential (`ai_chat_tools.py`, `mcp-tools.ts`), plus the editor tools.
  A new MCP tool is automatically a chat tool; keep `EXCLUDED_MCP_TOOLS` in
  step on both planes. `patch_scene` / `edit_app_source` replay
  `docs/ai-scene-patch-fixtures.json` on both.

## Writing scenes: `docs/scene-guide.md` is what every author reads

- How a scene is written — its JSON, the node types and edges, fields and
  state, code nodes, JS apps and the `frameos` API, where an app keeps its
  values, SVG, layout, small devices, events — is `docs/scene-guide.md`. The
  scene AI and the app AI on both control planes read it in their prompts,
  and both MCP servers serve it as `scene_guide`. A rule a scene author must
  follow goes there, not into one prompt: each consumer adds only what is its
  own (its tool names, its output format).
- After editing it, run `python3 frameos/tools/generate_scene_guide.py`. It
  fills the events table from `docs/events-contract.json` and the JS API from
  `frontend/src/utils/appTypeDeclarations.ts`, refuses when the runtime's
  `frameos` object or `app.frame` keys disagree with those declarations, and
  writes the backend and cloud copies (the backend suite runs `--check`). Then
  run the AI evals above. Keep it free of Nim: the cloud prompt is tested for
  that.

## Rendering on the server: `docs/server-rendering.md`

- An ESP32 with its own runtime can hand its scenes to its control plane
  (`render_mode: remote`; a backend's `device_config.renderMode`, "Render
  scenes" in Power). The plane renders in the wasm runtime, packs the panel
  bitmap (`pack_image_for_panel`, the cloud's port `panel-pack.ts`) and serves
  it at `GET …/embedded/render` with an ETag; the device sends its panel
  and gets a 304 when nothing changed. A C3 is always this.
- The plane is the memory (scene state, held events, the scene shown); in
  remote mode the firmware runs no scene work. What a board keeps in RAM
  beyond that (a UI's focus, keyboard and scrolls, the apps' `remember`
  values) goes out and back with every pull (`frameos_wasm_kept_state`,
  "Kept between pulls"; each pull is a new process) and is dropped at a
  sleep: a new per-process thing a scene relies on joins it. What its keys, touch, schedule
  and HTTP API would have handed its scene, `fos_events_dispatch` relays
  instead (`fos_render_relay.c`), and the next pull is a `POST` carrying it;
  the plane runs it through the one dispatcher in the same render
  (`frameos_wasm_device_input`, `relayed_input.nim`) and keeps the scene the
  render ended on. A new producer on the ESP32 goes through
  `fos_events_dispatch` and is relayed for free; never a second relay path.
  The scene still decides when it renders next: the plane answers every pull
  with `X-FrameOS-Next-Render` (its `nextSleep`, else its `refreshInterval`,
  held to 10 s on a backend and the plan's floor on the cloud) and the board
  wakes by it.
  On the cloud a frame set to remote is a cloud-rendered frame (quota +
  floor, `frameIsCloudRendered`). A sleeping frame's next picture is drawn
  before it wakes, with the scene's clock set to the wake (`nowMs`), and
  used once if nothing changed: keep that rule on both planes.
- The plane dithers to the palette the device's packer would
  (`activePalette(framePalette(stock))`: a photo's own palette, the frame's
  `palette`, the stock table); a change to that rule changes the backend's
  packer, `panel-pack.ts` and `embedded_main.nim` together.
- A board that says `X-FrameOS-Fosb: 2` gets FOSB version 2: deflated, and
  only the 64-byte blocks that changed since the picture its If-None-Match
  names (`fosb_v2` in `server_render.py`, the cloud's `fosb.ts`, pinned by
  `docs/fosb-fixtures.json`; the board checks the result by its sha256 and
  asks again whole). Every answer also says where a press on its picture is
  taken (`X-FrameOS-Press`, the runtime's `frameos_wasm_press_map`), and the
  board clicks from its touch task at once. And the runtime is told the
  board's panel (`set_frame`'s `pixelFormat` → `panel_shape.boardPanelFormat`):
  `app.frame.fast` / `paper` / `color` and the built-in scenes' look are the board's,
  never the plane's RGBX canvas. An ESP32 sets the same from its own panel at
  init, and nothing a scene asks of its panel reads a canvas: an event,
  init() and what runs after an await have none, and a 13.3" color e-paper
  on 8 MB draws in RGB565 like an LCD.
- The battery popover's offer reads `renderSceneMs` from the metrics
  (`serverRenderForecast` in `utils/batteryForecast.ts`).
- A board rendered on the server is sent nothing a scene holds ("Nothing
  to keep on the board"): one empty scene for its scenes (`docs/server-rendered-board-scene.json`),
  no account keys, verbs without their state or payload, decided when it is
  sent (the hub's `messageForServerRenderedBoard`, the backend's
  `frame_command_wire`). A new way to put scene content on a board checks
  `planeKeepsSceneState` / `is_thin_client_frame` first.

## Scenes inside scenes: `docs/scene-rhythm.md`

- A scene drawn through a scene node (a split's panel) renders on its own
  `refreshInterval`; one that is not due puts back a copy of what it drew
  last time (`frameos/src/frameos/scene_rhythm.nim`, one module for the Pi,
  the ESP32 and the preview). Copies are capped at a quarter of free render
  memory (1 MiB at most on an ESP32); without one the panel runs again with
  `FrameScene.repainting` set, which is the hook for exact repaints (#555).
- On an LCD or HDMI a generated split wakes for its first panel, its own
  interval no floor; on e-paper and a deep sleeper the interval is the fastest
  it renders. A panel that is not due and that a canvas still holds is not
  touched at all (`rdKeep`, `rhythmCanvasGeneration`; a new writer into a kept
  canvas that is not a render bumps that count or calls `rhythmForgetCanvases`). A `render` from outside the scene (API, cloud,
  schedule, button, console, preview) redraws every panel: `event_loop.nim`
  on Linux and in the preview, `fos_events.c` on the ESP32. Keep the two
  rules alike.

## Layouts and `<Scene>`: `docs/scene-layouts.md`

- A layout is one JSX app (`settings.isLayout`, in no scene list) with a
  `<yield />` (`scenes.yield` in the events contract) where the wrapped scene
  goes. `sceneLayoutProblem` and `scene_layout_problem` are the rule, pinned by
  `docs/scene-layout-fixtures.json`; both planes refuse anything else on save. What wraps a scene is the install's,
  like its button map: `layout: {sceneId, state}` beside `eventMap`, on the
  backend's `frame.scenes` entry and the cloud's `layouts` assignment column.
- The host keeps one scene. `interpreter.runEvent` enters the layout on a render
  pass and for pointer events (`routePointer`, which also gives a split's panels
  and `<Scene>`s their taps, in their own coordinates); yield goes through
  `runSceneNodeRender`. The frame's next wake is `syncRefreshInterval`'s, never a
  host's. Anything added to a layout pass goes in `interpreter.nim`, not in a host.
  A field's keyboard in the scene a layout wraps is the frame's (`KeyboardDock`,
  docs/jsx-ui.md "The frame's keyboard"): docked under the layout, which is laid
  out above it, or on a desktop a window over every other whose presses go to
  the field's UI past the layout (`keysTake`), so the focus and the windows stay.
  Its UI lays it out (`layoutUiDocked`), the interpreter draws it last and
  forgets the canvas when it comes, goes or moves.
  A scene asks its layout for the whole panel (a reader) with a public boolean
  field of `role: "fullScreen"`, else `settings.fullScreen` (`full_screen.nim`,
  `utils/fullScreen.ts`, doc section "Full screen"); the interpreter reads it
  each render pass where it reads `typing`, the layout hears
  `app.frame.fullScreen` and decides (a bare `<yield />`). Never a host's.
- `<Scene id>` and `<yield />` are holes in the canvas wherever they can be
  (`seekHoles` in `ui/layout.nim`, `holesOf` in `app_runtime.nim`; a slot with
  `hole` set): `renderSvgAround` draws the chrome, each scene goes through
  `runSceneNodeRender` into a view of the canvas, and a pass the UI has nothing
  to do in never enters it (`renderChrome`, `rhythmVisitChrome`, its own
  `chromeDueAt`). One that cannot be a hole (opacity, something painted over it,
  a scroller) is a raster image in the UI's SVG tree (`ukImage` +
  `fillSceneImages`), its picture under the panel copy budget
  (`SceneRhythm.embedImage`). A scene's `<Scene>` children live in `sceneNodes`
  under negative keys. Off the ESP32 an `on*` handler on a `<Scene>` is the layout's
  (`uiSceneHandler`, run from `routePointer` when the event reaches that scene),
  never a prop that makes a copy.
  A rectangle of the panel keeps its own damage record in `svg_frames.nim`
  (`takePanelRegion`): a new way to write a rectangle's pixels without a render
  of it takes that record too.
- **Windows** (`docs/scene-layouts.md` "Windows"; the `Windows 98`, `Tiling`,
  `macOS`, `BeOS`, `Classic Mac`, `NeXTSTEP`, `OS/2 Warp`, `Omarchy` and `Commander` samples): on a Pi, an ESP32 and in the browser when the
  page turns it on (`frameos_wasm_set_windowed`; the windowed
  `single_scene_host` is the ESP32's and the browser's), a layout can run the
  frame's scenes side by side. The runtime adds three things and no
  window manager: `app.frame.scenes` / `sceneId` (each scene with its own
  `settings.windowSize`, which a new window opens at: the ESP32's scene index
  carries it, so keep the three hosts' listings alike), a layout's bare `<Scene id>`
  resolving to the host's own instance (`hostSceneFor`; one with props stays a
  copy), and one layout instance carried across switches and put on at the
  switch (`carryLayout`, `wearLayout`; `carryLayoutState` across a push or
  reload); the focus is the frame's current scene. The built-in scenes are
  windows too: a host that runs scenes side by side keeps one the focus leaves
  (`builtInScenesStay`, `away`), and the two hosts keep the same rules, so a
  change to one host's windows is a change to the other's. UI drawn over a
  scene takes the pointer there, its tap included (`uiOverScene`,
  `UiRegion.scene`), and windows pace the frame (`windowsOf` in
  scene_rhythm.nim). Windows, positions and z-order are the layout's own state.
  A new window opens at the size `ownSize` gives it (the scene's own, else
  800x480: a desktop has no "Window size" of its own any more) where `freeSpot`
  puts it (bare desktop first, then the least overlap), and a desktop of
  another size (a new render scale, a resize) puts every window at the same
  share of it (`refit`), each the same text in
  all seven desktops of windows, and a list of scenes
  goes by category through `grouped` (the `category` name on each
  `app.frame.scenes` entry, the groups by name, Other last) and draws a scene's own icon through
  `ownIcon`, each the same text in all eight with a list: change any of them in
  every copy
  (`test_windowed_desktops.nim` checks they match), and `grouped` in the scene
  switcher (`sceneSwitcher/scene.nim`, the same rule in Nim) with them.
  The four with icons on the desktop (Windows 98, BeOS, Classic Mac, OS/2
  Warp) pick them with a rectangle and drag them about their grid with one
  set of functions, the same text in the four (`arranged` to `Band`; each
  icon's cell kept in the private disk field `iconSpots`): a desktop says
  only where its cells are (docs/scene-layouts.md "Windows", "Icons").
  Where memory is short only so many run at once (`app_runtime.windowLimit`, by
  the PSRAM the panel leaves (`memory.sceneMemoryBytes`): 2 on an 8 MB ESP32,
  1 on the 13.3" E1004, 4 on 16 MB, `app.frame.windows`): the layouts close the one
  that had the focus longest ago and the host holds to it whatever a layout
  does (`makeRoom`, `trimWindows`); an ESP32 without a desktop keeps one scene
  as before (`keepsInWindow`). The wheel stays off the ESP32
  (`when not defined(frameosEmbedded)`); the rest of it is in the firmware,
  about 22 KB of flash on the S3 (2026-11-15).

## JSX from JS apps: `docs/jsx-ui.md`

- A `.tsx` app's `get()` may return JSX as its image. `js_runtime/jsx.nim`
  reads the tree straight off the JS objects into pixie's `SvgNode`s (no
  JSON, no markup); an `<svg>` is drawn as it is, anything else is a UI that
  `ui/layout.nim` lays out (block, flex, grid, absolute; Tailwind classes read
  by `ui/tailwind.nim`) and **emits as SVG nodes**. There is one rasterizer:
  never paint a UI some other way, or it loses the damage repaint and the
  background waiver (`utils/svg_frames.nim`). pixie's SVG input is the
  `SvgNode` tree, markup included (`parseSvgNodes`).
- **Text is glyph paths, drawn from pixie's glyph cache** (`docs/jsx-ui.md`
  "The glyph cache", `pixie/paths.nim`): a glyph is kept as its coverage at
  its size and quarter pixel, four bits a pixel, and nothing of its outline
  stays in memory (no per-glyph path tables, no outline cache on the
  typeface). A new way to draw text goes through `fillText` or `glyphPath`,
  never a run's outline made per render; the cache stays the render
  thread's (`{.threadvar.}`), budgeted (on an ESP32 a 32nd of what the panel
  leaves the scenes, 64 to 128 KB, with a pass per render so a render over
  the budget keeps what fits) and emptied with the coverage cache when render
  memory is short. The built-in face is an
  indexed font read where it lies (`assets/compiled/fonts/Ubuntu-Regular.fosf`,
  pixie's `fontformats/indexedfont.nim`): after `generate_embedded_font.py`
  run `tools/generate_indexed_font.py` (its `--check` is in the backend
  suite), and never inflate a face whole into RAM on a device again.
  **The SD card's fonts are TrueType files read where they lie**
  (`docs/esp32-fonts.md`, pixie's `fontformats/filefont.nim`, `fileTypeface`
  in `utils/font.nim`): a face open is a few hundred bytes, its bytes come a
  512-byte page at a time through the render thread's page cache and its
  three memo tables (`fileFontPages`, `fontPageSlots`), the file is closed
  after each render (`releaseFontFiles`), and they read, set and draw as
  pixie's whole parse does (`test_file_font.nim` runs every shipped font):
  change a rule in `opentype.nim` and in `filefont.nim` together. What is not
  TrueType outlines is converted off the frame (`tools/font_for_card.py`),
  never parsed on it. The card's colour emoji font (CBDT) is read the same
  way, a glyph's PNG decoded when drawn and kept at its drawn size in
  pixie's colour glyph cache (`colorGlyphCacheBudget`), never the decode
  or the font. The glyph budget grows with the board's PSRAM
  (`glyphCacheBudgetBytes`: 128 KB on 8 MB, 512 KB on 16, 1 MB on 32).
  A frame gets more fonts by itself in the Fonts sample's "Get fonts"
  (docs/esp32-fonts.md): `repo/fonts/catalog.txt`, made by
  `frameos/tools/generate_font_catalog.py` (every file checked there, never
  converted on a frame), downloaded straight from where the files are in
  ranges by the scene's own JS, no firmware for it and no plane in the way.
- Handlers (`onClick`, …) and `hover:` / `active:` classes: the walker keeps
  each render's handler functions in the app's interpreter, the layout hands
  back the regions, and `ui/events.nim` hit-tests the scene's pointer events
  in `runEventInner` (every host) and dispatches `render` when something
  changed. A new handler is a `UiEvent` and a walker attribute, never a
  `case event` in a host.
- **Keys** (`docs/jsx-ui.md` "Keys"): Tab / Shift+Tab ring every element
  there is to press (one stop per element), Enter presses it, Escape lets
  go; a frame's buttons are those keys by role (a press once, the moment the
  key is up; a long press the event map's). The scene's own code hears a key
  first and keeps it with an event node or an `onEvent` that returns true
  (the desktops' Alt+Tab, the Commander's Tab). The scene's UI and its
  layout's are ONE walk with one ring (`interpreter.keysPlanned` / `keysTo`,
  `ui_events.uiKeys`), decided once at the top of `runEvent`; a built-in
  scene keeps its own (the switcher's highlight). A new way to reach an
  element is a stop in `uiKeys`, never a second ring.
- **A desktop's look** (`docs/jsx-ui.md` "Themes"): an element with
  `look="button"` (a role of the layout's `theme`) is dressed by
  `ui/theme.nim`'s `role`, as the Nim UIs are; one without keeps its classes.
  Never theme on `role`, which is ARIA's and the app's. `app.frame.theme` is
  the theme itself. The **Theme roles** sample draws every role, and
  `test_theme_roles_scene.nim` (`FRAMEOS_THEME_SHOTS=<dir>`) renders it
  under each desktop sample's looks.
- **Render scale** (`render_scale.nim`, `docs/jsx-ui.md` "Scale"): a .tsx /
  .jsx app is told its canvas is the panel divided by the scale, its UI is
  laid out at that size, and pixie stretches the root to the full target as
  vectors. The scale is a `role: "renderScale"` field's state, else the
  scene's `settings.renderScale`, else the frame's `render_scale` (0 =
  automatic, a WHOLE number by the panel's density: ppi over 130, rounded,
  at least 2 on a panel of 12" or more (a poster, read from across a room),
  never leaving a layout under 576 px; the size from the driver's name
  `EPD_10in3` or `NamedPanelInches`, an ESP32's display and a plane's render
  passing theirs; HDMI by the room it leaves, 1080 px; unknown 1: 2 on the
  E1003, the 13.3" E1004 and on 4K. The SPA's copy is `utils/renderScale.ts`, both pinned by
  `docs/render-scale-fixtures.json`). It is the ONE setting that sizes
  every scene: the built-in scenes are sized for a 480 px panel and laid out
  at it, render/text, a split's gaps and margins and data/qr's pixels are
  multiplied by it (`nodeRenderScale`), and a scene's UI never zooms itself
  up with the canvas (a picture that fills it may). Never scale by
  rasterizing small and stretching: pass the smaller size to the layout and
  the full one to pixie.
- **A panel's speed is not its material.** `app.frame.fast`
  (`panel_shape.panelIsFast`, `UiInput.slow`) decides when and how often to
  draw: presses, a drag taken whole, animation, `<img>` in the render, a
  split's interval, the built-in scenes' taps. `paper` (`panelIsPaper`) and
  `color` decide how it looks. Today fast is paper's opposite on every
  panel; a fast e-paper changes `panelIsFast` alone, so never key a speed
  decision on paper.
- Flash is the budget: the layer cost +37.3 KB on the ESP32-S3 image. A new
  class or element goes in `tailwind.nim` / `layout.nim`, `docs/jsx-ui.md`
  and the scene guide's JSX section, and the PR says what it cost (the
  firmware-size comment). Keep the reader allocation-free (classes read in
  place against packed word lists, `boundChecks`/`raises` pushed off): the
  first straightforward version was twice the size.

## Real-time rendering: `docs/realtime-rendering.md`

- A scene below a one-second `refreshInterval`, on an LCD, **animates** on the
  ESP32 (`main/fos_animation.c`, host-tested): frames paced in microseconds,
  the per-pass pulls, sensors and settings pushes once a second, one frame in
  ten seconds logged in full — its `render:done` is what a deploy waits for —
  with a `render:animation` summary of the quiet frames between. A new
  per-pass step in `fos_client.c` goes inside the `housekeeping` block unless
  it must run every frame, and a new per-frame log line costs frames: every
  line also goes out on the 115200-baud console.
- **The canvas is the panel where it can be.** An RGB565 LCD's canvas is its
  back frame buffer (`fos_display_render_target`, `frameos_nim_render_panel`:
  nothing packed, the blit a buffer switch); a sixteen-grey panel draws in
  pixie's `pfGray4`, half a byte a pixel in the panel buffer's own layout, every
  store dithered through the 4x4 ordered matrix (a new row copy in pixie uses
  `copyPixelRow`, and never copies a row down into a dithered gradient) and,
  unrotated on the ESP32, in the reserved panel buffer itself
  (`frameos_nim_share_canvas`: a new borrower of `fos_framebuffer_acquire`
  draws over the canvas and is counted for it), and any
  other grey or black-and-white panel in pixie's luma surface. The canvas rule has five copies
  (`frameos_display.h` lists them, `docs/device-limits-fixtures.json` pins
  two): change them together. A Pi with a 16 bpp RGB565 framebuffer (a
  HyperPixel 4.0) gets the same idea: one kept `pfRgb565` canvas
  (`frameos/panel_canvas.nim`, offered by the driver through
  `frameos_driver_panel_canvas`), and the framebuffer driver writes only the
  rows that changed (`drivers/frameBuffer/panel_push.nim`). A new write into
  that canvas that is not the scene's render calls `notePanelCanvasWritten`.
- **The background is owed, not painted** (`ExecutionContext.backgroundPending`).
  Anything that draws into the canvas other than a flow node calls
  `paintPendingBackground` first; a producer that takes the live canvas gets
  it painted by `takeDecodeTarget`, unless it settles it itself
  (`deferBackground` + `takeOwedBackground`, as the SVG path does with pixie's
  `coversOpaque`). `test_background_deferral.nim` starts from a canvas holding
  an old frame, so a debt nobody paid shows.
- **Per-frame code does not ask `availableRenderBytes()`.** The largest free
  PSRAM block is a walk of the whole heap on an ESP32 (0.5–2 ms); ask the
  free total (`availableRenderHeadroomBytes()`, microseconds) and leave the
  largest block to the one big allocation that needs it — pixie's decode
  budget measures it only when a decode asks
  (`setDecodeContiguousBudgetProvider`). On an RGB LCD a walk of a
  fragmented heap (5–7 ms, even on core 0) costs a frame from stale lines,
  because core 1 waits for the heap lock with interrupts masked: a number
  that is only logged takes `fos_heap_psram_largest_cached`.
- A frame that stays awake keeps its scene's JS interpreters between renders
  (`settleIdleJsAppRuntimes`; one holding a UI's handlers goes only when an
  allocation failed, and any discard is logged and, if it cost taps, shown on
  the panel: `reportInterpreterDiscards`), and a whole-frame SVG on an LCD repaints only
  pixie's damage box (`utils/svg_frames.nim`, keyed on the firmware's write
  count per buffer): a new writer into an LCD buffer that is not a render in
  place calls `fos_display_mark_written`.
- **Partial refresh on e-paper** (doc section of that name): a panel in
  `PARTIAL_PANELS` updates through `fos_display_update`, which keeps the exact
  picture on the glass, and `panel_damage.nim` dithers only the runs of the
  canvas that changed (a whole-frame Floyd-Steinberg would move every grey
  pixel below a change). A new way to put pixels on the glass goes through
  `fos_display_blit` or `fos_display_update`, or the copy goes stale; the
  panel stays awake between updates, so the chip's deep sleep parks it first
  (`fos_display_park`). The IT8951 (the reTerminal E1003) keeps the picture
  itself: `it8951.c` hashes tiles of the packed buffer and the table's
  `changed` / `clean` / `owed` replace the copy, because 1.25 MiB more does
  not fit an 8 MB board. Before a tap's upload it hashes only the render's box
  (`fos_display_hint_damage`, from `frameos_nim_render_damage`) and the whole
  picture once the waveform runs: a new way onto the glass or into the canvas
  that is not the render's own update goes through `fos_display_blit` /
  `fos_display_quick_update` or calls `fos_display_hint_forget`, or its pixels
  go up a waveform late (logged `changed outside the render's box`). Only GC16 (greys) and DU (pure black and white) draw
  on its waveform file: while someone taps, and for pictures coming quickly
  (`fos_pictures_fast`: an animation, a clock's seconds), it is one DU over
  all that changed, greys as a halftone, and GC16 once they stop
  (`fos_display_settle_due`).
  The IT8951 runs one waveform at a time (probed: a load elsewhere waits it
  out too), so a stroke being drawn is one DU after another: the driver
  uploads the changed tile runs exactly (up to 64), times each waveform's end
  off HRDY, and a render the scene asked for after input starts only as late
  as lets its picture be ready as the glass frees (`glass_slot_wait`,
  `fos_glass_slot_wait_us`; doc section "A stroke on e-paper"). Drawing scenes
  ask for a render at every move on every panel and keep `e.points`: never a
  pace of their own.
  While someone taps, slow chores wait (`input_hold_on()` in `fos_client.c`, the
  rule in `fos_animation.c`): the render task drains the touch queue, so a new
  network call or flash write on it goes behind the hold too, and a full refresh
  that only clears ghosts waits for the idle frame. Whether the ghosts are due
  one is the glass's wear, the pixels flipped per 16x16 tile since the last full
  refresh (`fos_ghost_add`, doc section "The ghosts, counted where they are"),
  never a count of updates or a timer. Better still, a chore leaves
  the render task: scene state is written by `scene_state_writer_task`
  (`main.c`), a frame that stays awake does its backend round trips (logs,
  picture push, pulls) on `backend_link_task` in `fos_client.c`, which applies
  nothing: a new pull hands its result to the render task the same way (and
  `link_hand_back` runs it before a deep sleep); a backend scene set is
  downloaded there, parsed on the render task and written by the scene
  store's own task (`store_task` in `fos_scenes.c`, paced around renders and
  taps: a flash write stalls both cores), and an
  e-paper driver starts its refresh and waits for it only before
  the panel's next use (`finish_waveforms`, `EPD_3in97_WaitPending`). A full
  refresh of any other SPI panel runs on the display's own task
  (`refresh_task` in `frameos_display.c`, the picture copied, the newest one
  next, `fos_refresh_queue.c`): a new panel entry point calls `refresh_wait`
  first (`test_esp32_refresh_queue.py` reads every bus taker for it), and a timed
  render waits while `fos_display_refreshing()`. Where an SD card shares the
  panel's bus (the E-series), the panel lends it for every wait it sleeps
  through with its chip selects high (`DEV_Delay_ms`, `fos_bus_share.h`): a
  panel chip select written behind `DEV_Digital_Write` would let a card clock
  the panel (`test_esp32_bus_share.py` reads for it). A touch
  board runs at 240 MHz like an LCD (`cpu_240` in `main.c`).
- **A press shows at once** (`docs/realtime-rendering.md` of that name,
  `fos_press.h`): an LCD's touch task shades the element under a finger (the
  press map's `taken` 3, `lcd_press.c`) in the buffer on the glass at its
  first report, before any render, under the loading mark's lock; the next
  present puts it away. E-paper lights the LED until the answer's waveform
  has run and, on a scene whose taps are slow, inks the box with one DU
  (`fos_display_glass_rect`: its tiles `stale` until an update sends the
  picture's own). A new writer into the scanned LCD buffer takes that lock and
  moves the buffer's count; one off the render task leaves it moved
  (`svg_frames.nim` checks the count after a copy). `touch tap` on the console
  is a finger through the touch task, for the bench.
- **A slow scene switch shows the loading mark** (`frameos/loading_mark.nim`,
  one drawing for both runtimes; doc section "A switch that takes a while"):
  after 200 ms without the new scene's first frame, a thread (Pi,
  `loading_mark_panel.nim`, straight into /dev/fb0) or a core-0 task (ESP32,
  `lcd_loading.c` + `lcd_st7701s_rgb.c`) draws it over the picture showing,
  and the next frame put on the panel ends it. A host's switch begins it
  (runner.nim `beginSceneLoading`, fos_scenes.c at apply), and so does every
  render pass somebody waits for (`rhythmAwaited`: a scene whose own interval
  is 5 s or more, on a pass that runs it, so a slow refresh shows it with nothing
  asking and a clock bar ticking every second does not), never the dispatcher. The mark writes behind the driver, so on a Pi every push to the
  driver goes through `withLoadingMarkAway`, and on the ESP32 every present
  runs `present_back` (which puts it away): a new push or present path keeps
  that, or the driver's row diff and the damage repaint go wrong. The
  firmware's e-paper has no mark: a load someone at the frame asked for chirps
  quietly on the buzzer instead (`fos_client_loading_begin`). The
  firmware builds RGB565 alone, with no flip, round panel or log line
  (`Only565`, `Flips`, `RoundPanels`, for flash): an option added later is
  the Pi's unless the ESP32 needs it, and the PR says what it cost there.
  A Pi's **mouse cursor** writes behind the driver the same way
  (`frameos/cursor_panel.nim`, docs/events.md "The cursor"): drawn into
  `/dev/fb0` over a kept copy, never into the canvas or any image, and
  `pushToPanel` puts it away before the driver writes and back after
  (`putCursorAway` / `putCursorBack`, inside `withLoadingMarkAway`): a new
  push path does both.
- **The 8-bit palette mode** (`frameos.pixels(cells, palette, options)`,
  `imageFromPixels` in `app_runtime.nim`, docs/realtime-rendering.md): a byte
  a cell into up to 256 colors, written into the panel buffer, which keeps the
  cells and colors it holds (`PixelFrame`) so only cells whose index or color
  changed are written, a cycled palette included. It is the one raster API, kept
  small for flash: RGBA cells, layers and writes into a canvas were built and
  taken out (#666). Bring one back only with a scene that needs it and the
  firmware-size comment's number.
- **A pixel loop can use both cores** (`components/frameos_nim/fos_rows.c`):
  `fos_rows_run` hands a job's rows out in blocks to the render task and a
  helper on the other core (resample.nim's draw is the first job). The job
  runs on a task the Nim runtime knows nothing about: plain values and
  pointers only, no ref, no allocation, no log, nothing that raises.

## Big text in a JS app: `frameos.openLines`

- A JS app's field with `"capabilities": { "byteIter": {} }` gets a spooled body
  as a stream instead of a string (`setDynamicJsAppField`, kept on the runtime
  in `spoolFields`), and `frameos.openLines` / `nextLine` / `nextBlock` read it
  in one window (`frameos/utils/line_reader.nim`; the stream API gets it too).
  The filters run natively on purpose: `only` drops a line before it is a JS
  string, because the JS heap and the 20 s interpreter budget are what limit a
  long feed on an ESP32. `repo/apps/json/icalJson` is the worked example; a
  new reader option is a `LineOptions` field and the declarations in
  `appTypeDeclarations.ts`. A reader lives for the call that opened it, and a
  temp file stays on the card while a reader holds its spool.

## Async JavaScript: `docs/async-js.md`

- Experimental, on a Pi and on an ESP32 that stays awake: `fetch` (a
  `Response`), the timers, `frameos.sleep` (promises), `frameos.useFetch`
  for `get()`, an async `init()` that goes on between renders (reading the
  newest config: `JsAppRuntime.liveConfig`), `AbortController` /
  `AbortSignal.timeout` for `fetch`, and
  `<img src="https://…">`, which the runtime fetches at the size laid out
  (`fillUrlImages`, after the layout) and draws when it is in: where it waits
  is the runtime's call (e-paper, a deep sleeper and wasm fetch in the
  render), never an option of the app's. Every interpreter stays on the
  thread that renders; a request goes to the I/O as values
  (`js_runtime/js_io.nim`: a Pi's four worker threads, an ESP32's on-demand
  task `components/frameos_nim/fos_js_io.c`, one TLS session at a time, which
  also runs the scene store's work: `fos_js_io_run`) and its answer comes
  back the same way. `pumpJsAsync` (`js_runtime/js_async.nim`) settles
  promises between renders: the Pi runner's message loop, the ESP32's
  `frameos_nim_tick` in the idle wait, where answers wait only while a tap is
  queued or 250 ms old (`fos_client_input_pending`), never the 10 s input
  hold. A runtime nothing pumps (`asyncPumped` false: wasm, a deep sleeper)
  answers the same calls blocking, so a scene written this way works
  everywhere. A slow scene is usually a render waiting on the network: move
  the wait into `<img src>`, `useFetch` or an async `init()`, never a
  `setNextSleep` loop around a synchronous `fetchImage` (what froze the Scene
  store, 2026-11-15). Not in the scene guide or `appTypeDeclarations.ts` yet:
  making it public is those two plus the AI evals.
- **A body bigger than memory is read in pieces**: `fetch(url, { onChunk })`
  (the doc's "A response in pieces"; `fetch.chunks` says a runtime has it).
  An ESP32's I/O task reads the body off the socket a piece at a time
  (`fos_js_io.c` `run_stream`, the glue's `fos_nim_http_stream_open_text`,
  gzip inflated by the ROM's tinfl), two pieces queued at most, and the pump
  hands each to the prelude's `__frameosChunk`; a `false` from the app, an
  abort or an interpreter gone stops the read (`cancelJsIo`). Where nothing
  pumps the pieces come inside the `fetch()` call (`jsFetchStream`). A Pi
  has the body whole first and cuts it up. The text rules (a character two
  pieces share, Windows-1252 for what is not UTF-8) are `utils/piece_text.nim`,
  one module for every runtime. A new way to get a big text into a JS app
  goes through it, never a bigger string.

## Reading the web on a frame: `docs/html-slim.md`

- **The runtime slims a page; the app reads it.** A page as its server
  sends it is mostly what an app has no use for (CNN's front page: 7 MB
  around 26 KB of words), and QuickJS on an ESP32 walks a string slowly (a
  loop iteration 4 to 6 µs, a regular expression over one tag ~175 µs).
  `fetch(url, { onChunk, slim: { keep, drop, bare, classes } })` hands the
  app HTML with its scripts, style sheets, comments and unlisted attributes
  gone and the rest written one way (`<name a="v">`, every `<` a tag, white
  space one space), by `frameos/src/frameos/utils/html_slim.nim` as the
  bytes come: one implementation for a Pi, an ESP32 and the wasm runtime,
  hooked in where a streamed piece becomes a JS string (`js_async.nim`
  `chunkArgs`). A change to what slimmed markup is, is the module, the doc,
  `utils/tests/test_html_slim.nim` and the Browser's reader together, and
  any cut of the input must give the same output.
- **The slimmer has the mechanism, the app has the lists and the meaning.**
  Which attributes stay, which elements go, which class words matter: the
  app passes them. What a page means (a block, a link, what is navigation,
  what is hidden, its colors) is the app's JavaScript, the Browser's
  `read.ts`. Do not move a rule about pages into the module: a reader in the
  runtime was built (30 KB of flash, 0.03 s a page) and taken out for its
  size the same day (2026-11-24); a second of reading in JavaScript was the
  owner's call. What keeps that second a second: the reader finds its way
  with `indexOf` on what the slimmer made regular, and runs no regular
  expression and no loop over letters per tag.
- **The Browser sample** (`repo/scenes/samples/Browser`) is its user, a
  browser the way Lynx and Opera Mini were: no style sheets fetched, no
  scripts run, a page in one column in the frame's type. `read.ts` reads
  slimmed HTML into the page, `page.ts` is the page (and feeds, plain text,
  Markdown, JSON), `lay.ts` breaks it into
  lines as far down as is looked at, with the built-in face's letter widths
  from a table (a line is drawn as one row that does not wrap, so the page's
  height is known before anything is drawn), `app.tsx` draws the rows that
  show, in the colors the page's own markup states (a `bgcolor`, a
  `<font color>`, an element's own `style`, the site's `theme-color`; what
  reads on what is `inkOn`'s). **Every letter drawn is a node the frame keeps** (a screenful of
  text is a thousand, three times that was one 380 KB block on an 8 MB
  board): draw what shows and a little around it, in pieces with a fixed
  place in the tree (`CHUNK`, `GROUP`), so the keys' ring stays on its link
  while the page scrolls. The page before stays up while the next one comes.

## Video: `docs/video.md`

- A Linux frame plays video through an ffmpeg CHILD PROCESS, never a linked
  libav: `frameos/video/player.nim` (a reader thread per video, a ring of
  frames in shared memory, no ref across threads) and `video/args.nim` (the
  command lines, pure). ffmpeg scales each frame to the `<img>`'s box in the
  canvas's pixel format, so the render thread's share is one copy; the
  player's image is a registered canvas, so a frame repaints the video's box
  alone, and the scene's `nextSleep` is the next frame's time
  (`js_runtime/js_video.nim` `fillVideos`, after the layout).
- JS: `frameos.video(key, {src, loop, paused, start, fps, fit, headers})`
  drawn with `<img src={video}>`, `seekVideo`, `releaseVideo`, `videoInfo`,
  `videoFrame`; one native, `jsVideo(op, json)`. An ESP32 and the preview
  answer "cannot play it" (`id` 0, `state` `error`) and draw nothing: keep the
  stub that small. A URL goes through `spawn_guard.nim` (pinned, protocol and
  playlist whitelists): a video is no shell command, and a cloud-managed Pi
  plays it. A new source of frames goes through the same guard.
- Scenes that call these need `video` (`utils/sceneNeeds.ts` `VIDEO_CALL`,
  the backend's `_scenes_use_ffmpeg` installs `ffmpeg` on Raspberry Pi OS, an
  ESP32's store asks `without=video`): keep the three alike. The samples are
  Video player, Files (its viewer), Immich videos, Camera wall, Video from
  URL, Archive films and Slow movie, all out of the playground.

## ESP32 memory: `docs/esp32-memory.md`

- Nim's allocator cannot refuse: on the device a failed allocation spends the
  1 MB emergency reserve, and without one it is a longjmp out of the render
  that leaks what the render held (the JS interpreters it was in included).
  **An allocation the size of a download asks first**
  (`memory.makeRoomForBlock`, as `http_client.requireRoomForBody` does) and
  raises an error its node can show. A text an app only parses is never made
  a string of: `frameos.fetchJson` parses the block the body came in
  (`boundedGetWhole`), and a body with a stated length is one block of that
  size (`fos_http_chunks.h`).
- An SVG that is drawn once and let go is parsed with pixie's `lateData`
  (`renderSvgIntoTarget`, `decodeSvgWithFallback`, `frameos.draw`): a long
  path's commands exist only while it is drawn. A parse kept for its damage
  (`svg_frames.nim`, `reuse`) is not.
- **A loaded scene keeps none of its apps' files** (the doc's "What a loaded
  scene keeps"): the scene reader takes a `SceneFiles` (where the scene's
  JSON lives: a file on disk, an ESP32's slot or the preview's payload by id
  through `sceneFileReader`) and keeps only the apps' keywords; an app reads
  its files when its interpreter starts and drops them after the compile
  (`JsAppRuntime.reload`). A new place that parses scenes says where their
  JSON lives, or passes `sfResident`, which keeps it all. No frame is sent
  an app's `*.test.*` files (`scenes_for_frame` / `scenesForFrame`).
- Measure on the board (`-d:memProbe`, `heapinfo`'s `min_ever_free`) and add
  what you find to the doc: a host model has been wrong both ways.
- **A scene's HTTPS request resumes its host's TLS session** (ESP32:
  `fos_tls_sessions.h`, `frameos_nim_glue.c` "TLS sessions resumed", the
  numbers in `embedded/esp32/README.md`): a full ECDSA handshake is 2 to 3 s
  there, a resumed one a few hundred ms. Every `mbedtls_ssl_handshake` of the
  firmware goes through a linker wrap that is the real call unless
  `http_open_request` marked the task (`tls_resume_begin` / `_end` around
  each connect, a session only ever offered to the host and port it came
  from). ESP-IDF's dynamic buffers leave a too-small receive buffer behind at
  the states a resumed handshake skips, so a connection that offers a session
  is stepped by `tls_handshake_resuming`: a new way to offer one goes through
  it, never `mbedtls_ssl_set_session` alone. No connection is kept open.

## Retiring a built-in Nim app: `docs/retired-apps.json` is the contract

- A Nim app that gets a repo JavaScript replacement (`data/immich` →
  `repo/apps/image/immich`) is deleted in the same change and listed in
  `docs/retired-apps.json`. Stored scenes become the JS app (backend alembic
  migration + import doors; the cloud converts at read time, its zips are
  immutable), every path to a device sends what that runtime reads (older
  firmware gets the Nim keyword back), and the Linux runtime runs the
  replacement for a scene still on disk. `docs/retired-apps.md` has the
  steps; run `python3 frameos/tools/generate_retired_apps.py` after touching
  the contract or a replacement's files (`test_retired_apps.py` checks it).
- A port must behave like the Nim app on an ESP32 too: a deep-sleeping one
  tears every idle JS interpreter down after each render, and one that stays
  awake (and the editor's preview running as one, which a tapped scene needs)
  does when memory runs short, so state that
  outlives a render goes through `frameos.remember` / `recall`, not module
  variables; a
  throw in `get()` fails the node like a raising Nim app (defaulted args, no
  cache entry). Port the Nim tests to `js_runtime/tests/test_<app>_js_app.nim`
  with `jsHttpRequestHook` / `contextDownloadHook`, and give the contract the
  first runtime with every bridge call the port makes (2026.10.13 for
  `remember`, `app.frame.embedded`, `fetchImage` `exif`).

## Per-photo colour profiles: `docs/asset-color-profiles.md` is the contract

- A photo may carry a `<image>.frameos.json` sidecar (exposure, white point,
  tonal tints, per-hue HSL, an optional
  dither palette). `frameos/src/frameos/utils/asset_colors.nim` applies it on
  every runtime; `frontend/src/utils/assetColors/` previews it with a port of
  the panel dither. The two are pinned to the same parity vectors
  (`test_asset_colors.nim`, `shared-spa/asset-colors.test.ts`): change the
  arithmetic on one side and the other, and refresh both vectors. The name
  is deliberately not dot-prefixed (device write paths refuse hidden names).
- The frame itself fits every drawn image into its palette's range by default
  (frame.json `colors.autoFit`, applied by the CONSUMER — `apps/render/image`
  and the JS draw call — on the rectangle it drew, never by the producer, whose
  output is cached) and runs a frame-wide `colors.global` correction on the
  finished canvas. A new control-plane key goes through the cloud contract
  (`docs/cloud-frames-contract.json` + generator), the backend column, the SPA
  key lists AND the settings nav list in `FrameWorkspace.tsx`.

## Photos: `docs/photos.md` is the contract

- Photos (the rail button after Apps) is a library of albums on the control
  plane, played by frames through share links. One HTTP contract
  (`/api/photos/...`, `docs/photos.md`) for both planes, and one data model:
  the backend keeps the cloud's tables in SQLite (`photo_entry`,
  `photo_share`) and the bytes in an object store under `photos/<sha256>`
  (`backend/app/utils/photos.py`, `object_store.py`: a directory under
  `FRAMEOS_PHOTOS_DIR` by default, an S3/R2 bucket when the
  `FRAMEOS_PHOTOS_S3_*` keys are set); the cloud keeps rows in Postgres and
  bytes in R2 under random keys (`cloud/apps/auth-web/src/lib/photos/`). A
  change to a route, shape or status code lands on both and in the doc.
- Frames never get the owner's credentials: a scene carries a share link
  (`pk_...`) in the `repo/apps/image/photoAlbum` node's config and asks for
  one photo per render (`/shared/{token}/photo?index=`), keeping its place in
  a disk-persisted state field. The share routes are on the backend's public
  router and are rate limited.
- A photo's color profile (the asset sidecar's `colors`, docs "Colors") is a
  `<photo>.frameos.json` sidecar on the backend (the path rules refuse the
  suffix, so it is never listed and travels with its photo) and the `colors`
  column on the cloud. Frames get it in the share JSON and hand it to
  `frameos.fetchImage(url, {colors})`. The editor is the Assets panel's
  (`ColorEditorModal`, preview math in `utils/assetColors/preview.ts`).
- The album scene has three builders (the SPA's, and `POST /api/photos/scene`
  on each plane); `docs/photo-album-scene.json` is the scene they all must
  build, and all three tests compare with it. Change one, change all three.
  The photos MCP tools (same names on both servers) gate every write on
  `confirm`: a frame playing a shared album shows the change.
- Thumbnails are made on the server on both planes (backend Pillow, cloud
  sharp at upload), so every upload gets one, MCP and API ones included.
  sharp is the cloud's one native dependency: `next.config.ts` traces its
  libvips in (the tracer misses it) and `cloud/scripts/stage-sharp.sh` gives
  a laptop-built release the box's linux-x64 build, or refuses it.
- Cloud uploads are scanned before anything is stored (hash list,
  PhotoDNA), and a configured scanner that fails stores nothing. Not OpenAI
  moderation: it scores `sexual/minors` on text only. Any new table holding photo objects goes into
  `cloud/scripts/object-store-sweep.sh`, or the sweep deletes the photos
  (it runs weekly with `--apply` now). Account deletion removes the
  account's photo and snapshot objects itself (`src/lib/account-erasure.ts`),
  and the object backup keeps deleted `photos/` and `frames/` 30 days only.
- **Photo bytes are private on the cloud.** The share `/file` route
  redirects to a ten-minute presigned R2 GET, `publicUrl` refuses
  `photos/` keys and a Cloudflare rule blocks the prefix on the CDN alias
  (the `/admin` check "Photos off the public CDN" fails without it). Never
  hand a photo out by a public URL again.
- **Photo metadata: inform, don't punish** (the owner's rule, 2026-10-18).
  Uploads are stored exactly as sent; never strip or rewrite a photo the
  owner did not ask to change. The library reads its metadata instead (a
  location pin on the card, the viewer's Info panel, `GET
  /api/photos/metadata`) and removes the location or everything only when
  asked (`POST /api/photos/metadata`, one photo or a selection). The reader
  and both removers are `app/utils/photo_metadata.py` and
  `src/lib/photos/metadata.ts`, which must agree byte for byte, pinned by
  `docs/photo-metadata-fixtures.json`: change one, change both and run
  `tools/generate_photo_metadata_fixtures.py`.
- **A share link inside a scene is the owner's alone.** The cloud store
  refuses to make a scene that holds one public or shared, and the scene
  AIs on both planes show the model a placeholder and restore the link in
  what comes back (`share-links-in-scenes.ts`, `photo_share_links.py`). On
  frames, errors and logs name a request URL only as `scheme://host[:port]`
  (`frameos/src/frameos/utils/redacted_url.nim`, `fos_netguard_url_origin`).

## Local network access: cloud frames only, `docs/lan-access.md`

- On a cloud-managed frame (or one still running cloud-pushed scenes) scenes
  may not reach the LAN (Home Assistant, a NAS, `192.168.x.x`) unless the
  frame's **Local network access** is on; the provider's own endpoint is exempt
  by exact `host:port`. Standalone and self-hosted backend frames have no
  block and no switch: their access is the network's call (the owner's
  decision, 2026-10-18). Never make it a permission apps or scenes declare
  (2026-10-17).
- Turning it **on** takes the six-digit code the frame draws on its panel
  (cloud `lan_access_challenge` / `lan_access_set`, or the Pi's
  `/api/network/local-access*` with an admin session). Off is free. The device
  holds the truth (`state/local_access.json`; ESP32 NVS `allow_lan`, off when
  absent) and reports it as `hardware.lanAccess`; the cloud keeps no copy.
- **A presence code must never leave the device in an image.** Draw it after
  the stored image (Pi: after `setLastImage`; ESP32: restore the rectangle
  before `store_snapshot`). Keep it away from every sink: `GET /image` (incl.
  e-ink drivers' own `toPng`), `image_get`, scene snapshots, the ESP32 BMP push,
  the `http.upload` driver.
- A check must pin the connect to the address it checked: the Pi connects by
  address, the ESP32 through `fos_netguard_pin_t` and lwIP's resolve hook.
  Checking a name and letting the client resolve it again is a DNS-rebinding
  hole.
- The blocked-request text starts with `Local network access is off for this
  frame`. The SPA's logs panel matches that prefix, so keep it on both
  runtimes.

## Virtual frames: both planes, two shapes, `docs/cloud-frames.md` "Virtual frames"

- A virtual frame has no hardware: the control plane renders its scenes and
  shows the picture at a link. The self-hosted backend's is
  `backend/app/api/virtual_frame.py` (embedded mode, `platform: "virtual"`,
  `is_virtual_frame` at each route that needs to know). The cloud's is a
  paid-plan entitlement (`cloud_rendered_frames`, none on Free) and is built
  the other way round: **the frame hub runs its device**
  (`cloud/apps/frame-hub/src/virtual-device.ts`), which speaks the frame side
  of the wire contract behind an in-process socket. A cloud route, MCP tool or
  panel that works on a frame works on a virtual one; do not add an
  `is virtual` branch to a cloud route — teach the device the verb, or answer
  it `unsupported_verb` and hide the control (`workspaceSurfaces.ts`,
  `isVirtualCloudFrame`).
- **A frame is virtual because of its `virtual_frames` row**, which only the
  create route writes. `hardware.platform` is what a device says of itself:
  the SPA draws by it, the quota counts by it, and nothing trusts it.
- The hub renders with auth-web's `scene-render.ts` and the runtime auth-web
  ships. Its tests fake the renderer (`virtualRender`), except one that runs
  the real runtime when `public/frameos-wasm` is installed. A change to what
  a render is told (settings, state, events, size) is tested there.
- It renders on a verb, and on its interval only while somebody looks
  (`viewed_at`, `preview_watched_at`), never under the plan's floor. Keep
  both bounds: renders per day are what a virtual frame costs.
- The view link (`/v/{token}`) shows the picture and nothing else, and its
  token appears in no log and no audit row. Virtual frames are their own
  quota pool (`countFramesForAccount` leaves them out).
- Deliberately one-sided: assets and a color mode exist on the backend's
  virtual frame and not on the cloud's (yet); the plan gate and the hub
  device exist on the cloud alone.

## The browser flasher: `cloud/docs/flasher.md`

- `flash.frameos.net` (GitHub #904) flashes an ESP32 with no account: a
  standalone frame (the S3 hardware presets, `?board=` links from
  frameos.net), a frame whose backend is on plain http (the backend's USB
  card opens it in a window and hands it the frame: the bridge,
  `frontend/src/utils/flasherBridge.ts`), or a setup file. It is
  cloud-frontend's second entry (`src/flasher`, `build.mjs`), served by
  auth-web's `app/flash` and host-routed like the playground
  (`surfaces.ts`, `FRAMEOS_FLASHER_APP_URL`); its host strips the cookie and
  serves no API but `GET /api/frames/firmware`, the store's public listing
  and covers, and `POST /api/flasher/events`, its anonymous counts
  (`flasherServesApi`; `cloud/docs/flasher.md` "What is counted": a new
  property goes on the route's list and on the privacy page too).
- **One engine**: `scenes/workspace/embeddedFlashRun.ts` (`flashAndSetUpBoard`,
  `updateBoardKeepingSettings`, `provisionOverUsb`) is what the backend's
  USB buttons and the flasher run. A fix to how a board is flashed goes
  there once. It and `embeddedFlashShared.tsx` import no workspace and no
  `framesModel` (they cost the page 5 MB): keep UI in its own file
  (`EmbeddedUsbConnectionButton.tsx`).
- **Every browser flasher checks every image against the release signature**
  before writing it (`releaseFirmware.ts`, `utils/releaseSigning.ts`; both
  planes' `/api/frames/firmware?platform=…&signature=1`, the trusted comment
  must name `frameos-<release>-<platform>.bin`). The flasher writes nothing
  unsigned; a plane's own flasher writes its `local-dev` build after saying
  so. A new way to get firmware bytes into a browser goes through a
  `FirmwareSource` that verifies.
- **The setup document** is backend `GET /api/frames/{id}/embedded/setup`:
  the provisioning plan plus `embedded_scenes_payload` (what the board's own
  pull gets: never the stored list as it is). The backend's own flasher takes
  its post-flash scenes from it too. A field added to it is read by
  `parseFrameSetupDocument` and pinned by `test_embedded_setup.py`. A setup
  never carries `cloud_url` / `claim_token`: a board joins the cloud from the
  cloud's flasher. Backend-only by nature (the cloud is always a secure page).

## The playground: `cloud/docs/playground.md`

- `playground.frameos.net` is a page of auth-web (`app/playground`,
  `src/lib/playground.ts`, host routing in `src/lib/surfaces.ts`): the
  release-pinned wasm runtime the size of the window, windowed, with the
  repo's sample and gallery scenes on the Windows 98 desktop and the Scene
  store. It ships with every cloud deploy, a release's new runtime included;
  there is no deploy of its own. A new sample is in it unless it needs a key
  or a Pi (`excludedTemplates` in `scripts/build-playground-scenes.mjs`).
  It is no app origin: only the store's preview proxy accepts it. Never
  return a rewrite from `proxy.ts`: behind nginx Next takes it for another
  server and sends it back through the routing (the playground root's loop,
  2026-11-16); mark the request and rewrite in `next.config.ts`.

## Paid plans: `cloud/docs/billing.md`

- Cloud-only by nature. Sold through **Stripe** (`src/lib/stripe.ts` the
  API, `src/lib/billing-provider.ts` the mapping). Stripe is not a merchant
  of record: Raaven BV sells, Stripe Tax adds the VAT, and the ledger books
  it as owed (`liability:sales_tax`) and Stripe's fee as a cost
  (`expense:psp_fees`, converted from the euro balance at Stripe's rate). A
  Creem adapter was built and removed on 2026-11-07 after Creem's review
  demanded its moderation API on prompts that reach the on-device image
  app; don't bring a merchant of record back without reading that history.
- **A webhook is a nudge**: every subscription, invoice, refund and dispute
  it names is read back in the pinned API version (`stripeApiVersion`),
  never taken from the payload, which is rendered in the endpoint's version.
  A Stripe call goes through `stripe.ts`; the integration suite's stand-in
  (`src/test/stripe-fake.ts`, a real HTTP server) refuses parameters it
  does not know, so a new call or parameter needs it taught there too.
- **A plan lists only what exists.** The catalog
  (`cloud/apps/auth-web/src/lib/plan-catalog.ts`) names unbuilt features and
  limits in `plannedFeatures` / `plannedLimits`: the plan cards mark them
  "planned" and a plan's row does not grant them. Take a name off those
  lists in the change that ships the feature, never before. The public
  price list is frameos.net/pricing (`content/docs/pricing.mdx` in
  `frameos-docs`, numbers repeated by hand); the cloud's `/pricing` only
  redirects, to the usage page when signed in.
- **An account's plan changes only on what Stripe says**, through
  `applySubscription`, which is idempotent; the ledger side is
  `packages/ledger/src/provider-subscriptions.ts`, where the provider owns
  the clock and the nightly cycle skips `subscriptions.provider` rows.
  Changes are worked out from the plan paid for, never Stripe's current
  price. Test-mode payments never post to the ledger. Every change of plan
  is a `cloud plan …` PostHog event (`plan-notifications.ts`, posted to the
  Discord reports channel by the "Cloud plans" workflow), sent by the write
  that made the change (a payment applied, a status moved by
  compare-and-set), never from a before-and-after read: the checkout
  return and the webhooks race. A change to the flow
  is run against Stripe's test mode before it ships (the doc's checklist
  and its last results). Live mode sells to superadmins only until
  `STRIPE_CHECKOUT_OPEN=1` (`checkoutOpenTo`): a real payment is made and
  refunded first.

## Top-level layout
- `backend/` – Python FastAPI application that exposes REST/WS APIs, schedules background jobs, and manages persistence via SQLAlchemy. Includes Alembic migrations, ARQ worker tasks, and pytest suites. 【F:backend/app/fastapi.py†L1-L101】【F:backend/app/tasks/worker.py†L1-L64】【F:backend/app/models/user.py†L1-L16】
- `frontend/` – React + TypeScript single-page application built with esbuild, Tailwind, and kea state management. Compiled assets live in `frontend/dist` and are served by the backend when present. 【F:frontend/package.json†L1-L66】【F:backend/app/fastapi.py†L38-L86】
- `frameos/` – Nim-based runtime for devices, containing system drivers, Nim app definitions, and assets compiled into the on-device application. Nim apps live in `src/apps`; repo-provided JavaScript app templates live outside the runtime under `repo/apps/<folder>/<app>`, the folder naming what the app returns (`image`, `text`, `json`, `logic`). Entry point `src/frameos.nim` is a small CLI (see "Device runtime" below); `make build` writes the binary to the gitignored `frameos/build/frameos`.
- `e2e/` – The end-to-end suites: the scene-renderer snapshot harness (`e2e/run`, `e2e/snapshots`), the Playwright frontend suite (`e2e/frontend-visual`, incl. the cloud `/frames` specs) and the opt-in real-SSH deploy test (`e2e/deploy`). `e2e/README.md` describes each, how CI runs them and which snapshots CI commits itself.
- `embedded/` – The ESP32 firmware (`embedded/esp32`, ESP-IDF + the Nim runtime compiled to C) and the Pico W / Pico 2 W thin client (`embedded/pico`, pico-sdk C; Pimoroni Inky Frames). Neither control plane builds firmware: both flash signed release images (a Pico's is a `.uf2` dragged onto the BOOTSEL drive, then provisioned over the same `usb_api` console as an ESP32). The Pico is a thin client by hardware — its PSRAM cannot be memory-mapped — so a plane renders for it. The cloud renders for thin clients (an ESP32-C3 links to it), but the Pico's firmware has no cloud client yet, so the self-hosted backend is its only plane for now (`embedded/pico/README.md` "Limitations", `docs/embedded-todo.md`). The IDF-free ESP32 modules have host tests (`embedded/esp32/main/tests`, see that README's Layout); the Pico's SDK-free modules have theirs in `embedded/pico/tests` (`make -C embedded/pico/tests`).
- `ios/` – The native iOS app (SwiftUI) for both control planes; `docs/ios-app.md` is how it stays in step with the SPA, `ios/README.md` how to build it.
- `cloud/` – FrameOS Cloud: the hosted service (Next.js + Drizzle/Postgres) behind `cloud.frameos.net` and `scenes.frameos.net` (legacy `account.frameos.net` redirects) — accounts, device/backend linking, and the scene store. Part of the monorepo's single pnpm workspace (one root lockfile, Turborepo builds); run pnpm commands from `cloud/`, see `cloud/README.md` and `cloud/docs/cloud-frames.md`. CI runs via `.github/workflows/cloud-ci.yml`.
- Supporting files at the root include the Docker configuration (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`), the install/setup scripts under `scripts/`, and the version metadata (`versions.json`, `project-folders.json`, `buildroot-images.json`, `cross-toolchain-images.json`) for packaging and deployment. There is no Procfile any more.

## Backend notes
- Environment configuration uses `Config` classes driven by env vars such as `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `HASSIO_RUN_MODE`, and debug/test toggles. During development (`DEBUG=1`) it autogenerates a `.env` with a fallback `SECRET_KEY`. 【F:backend/app/config.py†L1-L86】
- FastAPI application wiring (in `app/fastapi.py`):
  - Registers gzip middleware, websocket routers, and routes grouped by auth level (`api_public`, `api_open`, `api_user`, `api_project` — see `backend/app/api/__init__.py` for what each means with and without Home Assistant ingress).
  - Serves compiled frontend assets (or source HTML during tests) unless running in Home Assistant public ingress mode.
  - Initializes a shared `httpx.AsyncClient`, Redis listener, and PostHog analytics integration during startup.
  - Custom exception handlers degrade gracefully to JSON for API calls and reuse the SPA shell for 404/validation errors in non-test scenarios. 【F:backend/app/fastapi.py†L1-L112】
- Persistence uses SQLAlchemy ORM models (e.g., `User` with hashed passwords) and Alembic migrations (see `migrations/`). Session factory exposed from `app/database.py`. 【F:backend/app/models/user.py†L1-L16】
- Background jobs run through `arq` with Redis: worker defined in `app/tasks/worker.py` loads tasks for deploying/resetting frames, building SD images, and controlling agents. Startup hooks share HTTP, Redis, and DB clients. Run via `arq app.tasks.worker.WorkerSettings`. 【F:backend/app/tasks/worker.py†L1-L64】
- API tokens (`app/models/api_token.py`, `fb_api_…` / read-only `fb_apiro_…`) are accepted by `get_current_user` wherever a login JWT is; the MCP server at `POST /api/mcp` (`app/api/mcp.py`, `app/mcp/`) wraps the backend's own routes in-process over ASGI — a new tool is one HTTP call to an existing route, never new behaviour (the photos tools' URL download and scene install are the two noted exceptions in `docs/mcp.md`), and one that changes a physical frame takes `confirm` (the gated list is pinned by `test_mcp.py`). A string argument that lands in a route path goes through `segment()` (`app/mcp/client.py`) and carries a `pattern`: httpx normalizes `..`, so a free string could name another route. The client refuses a path with a dot segment or a query whatever a tool did, and `test_mcp.py` reads the tools for an unquoted one. `docs/mcp.md` is the contract; the cloud's `cloud/packages/mcp` is the sibling to keep tool names in step with.
- **A frame's backend address is three fields and one reading: `docs/server-address-fixtures.json`.** `server_host` is a bare host, `server_port` the port, `server_scheme` `http` | `https` (frame.json `serverHost` / `serverPort` / `serverScheme`; the ESP32 keeps the one URL they make). The scheme is stated by every writer and never guessed from the port once stated; the ONE seed for a row or frame.json from before 2026.9.13 is "a port ending in 443 is https" (`scheme_from_port`, `serverSchemeFromPort`). Wherever an address is TYPED (the add-frame and adopt forms, the frame settings' host field, the Wi-Fi portal, the device's own frame API, frame.json on load) it is split by the same parser — `app/utils/server_address.py`, `types.nim` `splitServerAddress`, `utils/backendAddress.ts` `splitServerAddress` — and what it says (`https://host:8443`) lands in the scheme and port fields and wins over them; the three fixture runners pin the parsers. A URL for the device comes from `server_base_url(frame)`; do not rebuild `scheme://host:port` by hand, and never add a fourth port rule.
- **Fetching a URL a user or a page supplied, on either plane: the check goes in the connect.** Checking a name and letting the HTTP client resolve it again is a DNS-rebinding hole (the second answer can be private). Backend: an `httpx.AsyncClient(transport=guarded_transport(...))` (`app/utils/network.py`), with the same policy as the route's up-front `assert_url_target_allowed`. Cloud: `guardedFetch` / `pinnedFetch` (`cloud/apps/auth-web/src/lib/ssrf.ts`, undici with a guarded `lookup`). The child-process fetchers (`scene-render.ts`, `backend/tools/embedded_wasm_render.mjs`) put the check in the socket's `lookup` via `node:http`.
- Tests rely on pytest + pytest-asyncio fixtures defined in `app/conftest.py`; there is broad coverage across API, websocket, and model layers under `app/api/tests` and `app/models/tests`. 【F:backend/app/conftest.py†L1-L65】【F:backend/app/api/tests/test_frames.py†L1-L183】
- Common local workflows:
  - Install dependencies: `pip install -r requirements.txt`. The lock carries a `--hash` for every file and is a *universal* resolution (it is compiled on macOS and installed on Linux); CI and the Docker image install it with `--require-hashes`. Regenerate it ONLY with `backend/bin/compile-requirements` (`--upgrade-package <name>` to bump one package) — a plain `pip-compile` drops the hashes and the Linux-only packages, and every CI install fails. After it, refresh `tools/buildroot-images/requirements-upload.txt` (recipe in its `.in`).
  - Run the web server: `uvicorn app.fastapi:app --reload` (ensuring `frontend/dist` exists or `TEST=1` to use source HTML).
  - Start worker: `arq app.tasks.worker.WorkerSettings`.
  - Execute tests: `pytest` (optionally via `backend/bin/tests` helper). 【F:backend/bin/tests†L1-L3】

## Frontend notes
- Built as an ESM React app with TypeScript; kea manages state and type generation (`kea-typegen`).
- Build pipeline orchestrated by `build.mjs` using esbuild, with Tailwind/PostCSS for styling and optional bundle analysis via `vite-bundle-visualizer`.
- Development: `pnpm install` followed by `pnpm --dir frontend run dev` (spawns kea typegen watch and esbuild dev build concurrently).
- Repo-level local development runner: `pnpm dev` starts `mprocs` (`mprocs.yaml` is the process list). Panes that autostart: `backend` (FastAPI, `DEBUG=1`), `worker` (ARQ), `vite` and `kea` (the main frontend's dev server and its typegen watcher), `editor` (the embedded editor bundle `frontend/dist-editor`, rebuilt on change for the local scenes page's iframe), `redis`, `postgres` (the Flox-provided Postgres on port 55432, via `cloud/scripts/db-run.sh`) and `wasm` — which runs `frameos/tools/build_wasm_watch.sh`: `build_wasm.sh` (a Nim → emscripten build of the interpreted-scene runtime, for the browser preview and for every frame the backend renders: thin clients, boards set to render on the server, virtual frames) on every `pnpm dev`, and again whenever the runtime's sources change, so a merge does not leave the backend drawing with an older runtime. Panes that do not autostart (select them in mprocs): `frameos` (`make` in `frameos/`, the native runtime), `cloud` (the FrameOS Cloud Next.js dev server; it first runs `cloud/scripts/db-setup.sh` to apply migrations), `cloud-hub` (the frame hub, `pnpm run dev:hub` in `cloud/`), `playground` (the playground, `cloud/docs/playground.md`, on the runtime the `wasm` pane builds, installed again after each rebuild: the cloud's dev server, so start it instead of `cloud`; it prints the address, `http://localhost:3000/playground`), `backend-docker` (`scripts/backend-docker.sh`, which persists a generated Docker `SECRET_KEY` in the gitignored `.env.docker.local`) and `migrate` (alembic upgrade for the backend). There is no pane for the on-frame admin frontend; run `pnpm dev:frame-frontend` (its watcher in `frameos/frontend`) by hand when working on it.
- Production build: `pnpm --dir frontend run build` which chains kea codegen, schema generation (`ts-json-schema-generator`), TypeScript type-checking, and final bundling to `dist/`. 【F:frontend/package.json†L6-L66】
- The published `frameos-editor` package has its own `editor` component hash/version in `versions.json`; `project-folders.json` includes shared frontend sources so frontend-only editor changes receive a new npm version during release.
- Output folder is consumed by the backend’s static file mounts; ensure `frontend/dist` exists (e.g., via `pnpm --dir frontend run build`) before running the Python app outside of test mode. 【F:backend/app/fastapi.py†L38-L86】
- UI copy follows `docs/ui-vocabulary.md`: scenes are **pushed**, settings and FrameOS **deployed**, a show-for-now is a **preview**, a scene going on the list is **installed**. `frame-vocabulary.test.ts` (cloud shared-spa) scans `frontend/src` for the banned words; a new verb goes in the doc first.
- **One scene workspace, both planes: `frontend/src/sceneWorkspace/`.** The scene store's page (scenes.frameos.net/s/…): the bar (Back, Editor · AI · Preview, the name, the actions), the panels as resizable columns, the AI assistant (`SceneAiPanel`), the live preview (`SceneLivePreview`) and their libs. It lives in the shared frontend, moved there from `cloud/apps/auth-web` (which imports it back; `SceneEditorModal.tsx` keeps what is the store's: versions, install, fork, save). What differs per plane is passed in or set once: the editor column (`Editor`: the store's `frameos-editor/react`, a frame's `FrameSceneEditorColumn` over the real `frameLogic`, a saved scene's editor bundle in an iframe; each is `SceneEditorBody`, the file tree on the left), the bar's actions, and the routes (`lib/host.ts`: fetch, AI chat, settings, preview proxy, analytics). Its CSS is `sceneWorkspace.css` (the cloud's layout imports it after `globals.css`); the SPA adds `sceneWorkspaceSpa.css`, the cloud's palette and primitives scoped under `.frameos-scene-workspace`. A frame's scene page (`/scenes/:frameId/:sceneId`, `SceneEditorPage`, on both planes) is that workspace over one scene: Save and Save & push, no versions, no Install. A backend's saved scene (`/scenes/local/<id>/edit`, `LocalSceneEditor`) too, its editor column the editor bundle `frontend/dist-editor` served by the backend at `/frameos-editor/` (in dev `pnpm dev`'s `editor` pane rebuilds it on change, `node build.mjs --dev --editor`, and Vite proxies the path), saved with `PATCH /api/templates/<id>` (`name`, `description`, `scenes`; layouts checked as on every save). **Every way into editing a scene opens one of these three pages**: a frame scene's Edit (tile menu, drawer, the frames home, the Installed library, the chat's links, an install, a new blank scene), a saved scene's tile and Edit (the library, the home page, the Add scene drawer), a store scene's page. Do not add another editor surface or a modal that edits a scene's graph. The workspace's preview imports `frameos-wasm`; the SPA builds (frontend, cloud-frontend, the on-frame admin) take it from `frameos/wasm/src` through `paths` in their tsconfig (and an alias in `frontend/vite.config.ts`), so no package build runs first; auth-web resolves the built package. A change to the workspace is a change to both planes: run the cloud's tests (`SceneEditorModal.test.tsx`, `SceneAiPanel.test.tsx`, `SceneLivePreview.test.tsx`) as well as the SPA's checks.
- ALWAYS prefer writing frontend business logic in kea logic files over using effects like `useState` or `useEffect`.
- This includes small functions and callbacks inside components. Prefer to keep as much code as possible in logic files, treating React as a templating layer.
- When adding a frame model key that is tracked for deploy changes in `frontend/src/scenes/frame/frameLogic.ts`, also add a marker to `FRAME_KEY_INTRODUCED_FRAMEOS_VERSION`. For unreleased work, use the next patch after the current `versions.json` FrameOS base version.

## Device runtime (Nim) notes
- **HARD RULE — no image proxies for frames, EVER.** Frames download and render
  images directly from their sources; never route a frame's image fetches
  through the backend (or any other middleman) to resize or fetch on its
  behalf, and don't paper over device limits with host-side resize params
  either. When a source serves images too large for a device, THE fix is
  better on-device streaming decode (incremental inflate, row-by-row
  unfilter/scale into the target — a multi-MB PNG should need its compressed
  body plus a few rows, not a full-resolution RGBA buffer). Proxies are fine
  for in-browser previews only. Proxying has been implemented and reverted
  before — do not implement it again.
- **Refs do not cross threads.** The frame's web server runs up to four mummy
  worker threads next to the runner, the logger, the hub client and the
  scheduler, and ORC refcounts are not atomic: a `ref` (JsonNode, FrameConfig,
  StateField, ExportedScene, Logger…) that two threads hold is freed under one
  of them sooner or later, and a type with closures also lands in the wrong
  thread's cycle roots. This has crashed frames twice (the auth cache,
  2026-09-06; `getLastPublicState`, found 2026-09-19 — four threads segfault
  in a second). A global that crosses threads holds VALUES (strings, plain
  objects) or is only read under the lock that writes it; hand out copies;
  never write `let x = globalFrameConfig` (or `.settings`, `.network`, …) on
  a worker — use `liveConfigValue(field)` (`server/state.nim`) for one string
  or number, `requestFrameConfig()` / `readConfig()` for a private config,
  `getLastPublicSceneState()` / `publicStateFieldsCopy()` for scene state. A
  thread that lives long keeps its own copy and refreshes it when
  `currentFrameConfigGeneration()` moves (the hub client does). A `Channel` MOVES its message under ORC, so `sendEvent` copies the
  payload; `sendEventOwned(name, move(payload))` is for a fresh parse too big
  to copy. New shared state gets a four-thread test built with
  `-d:useMalloc` (`test_public_state_threads.nim` is the template).
  A ref type that is handed between threads by design (the scene registry's
  `ExportedScene`: built on the main thread at boot, let go on the runner's
  after a reload) is `{.acyclic.}`: ORC files a cyclic ref's cycle candidates
  per thread, and one filed by one thread and destroyed on another corrupts
  both lists (`test_scene_registry_threads.nim`; a Pi's SIGSEGV after its
  second settings push, 2026-11-24).
  A proc that can run on more than one thread takes the config it reads as
  an argument (the portal's `startAp`, `attemptConnect`): the caller hands in
  the runtime's own on the runtime's thread and a `portalRequestConfig` /
  `requestFrameConfig()` anywhere else, and a thread it spawns gets values.
- `frameos/src` houses the on-device runtime written in Nim with asyncdispatch (`frameos/frameos` and `frameos/build` are untracked build outputs, not sources).
- **pixie is in the tree** (`frameos/pixie`, a squashed subtree of the FrameOS fork since 2026-11-07; `config.nims` puts its `src/` on the path, `FRAMEOS_PIXIE_PATH` points at another checkout). A change to the rasterizer, the SVG reader or the codecs is an ordinary change here: run `make test-pixie` (its own image tests) next to the FrameOS tests. A change to a decoder, a font reader or the inflater also gets `make fuzz-pixie` (every fuzzer in `pixie/tests` with the checks a release turns off left on, under AddressSanitizer; the **pixie fuzzers** workflow runs it on such a change and nightly): a fuzzer's open finding is fenced off in the open (`tools/run_pixie_fuzzers.sh`), and the fix takes the fence away. Interactive render performance is `docs/perf-todo.md`; the device's `set debug 1` puts a per-phase split on every render line (`frameos/render_probe.nim`).
- Entry point `src/frameos.nim` is the runtime's CLI, not a bare `waitFor startFrameOS()`: `start` (the default, also for any unrecognised `--flag`) runs `startFrameOS()` in a retry loop with the boot guard; `version` / `--version` / `-v` prints the compiled version and exits — it used to fall through to `start` and boot a second runtime next to the service, which is how release 9.2 shipped a 9.1 runtime, so keep that branch first; `check` verifies the binary starts; `setup` (`--with-setup=/boot/frameos-setup.json[.gz]`, `--reboot-if-required`) runs first-boot device setup; `driver-setup` and `set-display` (`--device`, `--width`, `--height`, `--rotate`, `--vcom`, `--upload-url`) patch and apply the display; `upgrade` (`--dry-run`, `--no-reboot`) pulls the latest GitHub release; `privileged-worker` is the root side of the privileged door on Buildroot frames; `help` lists them. Drivers, system integrations, and Nim app implementations live in nested directories (`src/apps`, `src/drivers`, `src/system`, `src/frameos`); JavaScript example app sources/configs live under `repo/apps/<folder>/<app>`.
- JavaScript repo apps under `repo/apps/<image|text|json|logic>/<app>` are catalog templates for custom code apps; a scene copies one into its own `apps` map, with `origin` naming the template (until 2026.10.13 they all sat under `repo/apps/code`, and readers match an old origin by the app's name). Do not generate or commit Nim wrappers inside `repo/apps`; compiled scenes that use them copy their sources into generated `src/apps/sceneapp_*` folders during build/deploy.
- `frameos/Makefile` is the build entry: `make build` (app loaders → driver sources → shared driver libraries → assets → `nim c src/frameos.nim` into `build/frameos`), `make run`, `make test` (`nimble test`), `make test-shard SHARD=n` (what CI's "FrameOS Nim Tests" shards run, via `tools/run_test_shard.sh`), `make cross-<target>` / `make release-<target>` / `make release-all` (`backend/bin/cross`, the Docker cross-toolchain builds). `frameos.nimble` holds the dependencies and the `build_quickjs` task; `nimble build` itself can crash the compiler on macOS, so prefer `make build` / `nim c` directly. `nimble.lock` is the truth for package versions (bump a pin in `frameos.nimble` with it); the gitignored `nimble.paths` is `nimble setup`'s copy of it, `config.nims` refuses one older than the lock, and `python3 tools/nimble_paths.py` refreshes it (the Makefile, `build_wasm.sh` and the ESP32's `build_nim.sh` run it first).
- **Nim test cost is compile cost.** Every test file is its own binary and compiles most of the tree (a server or interpreter test is ~6 s of Nim frontend plus 300 C files; the 45 MB `src/assets/repo_scenes.nim` string-literal module is NOT the problem, it compiles in under 2 s). `config.nims` builds `-d:testing` binaries with `--opt:none`, which halves a cold C compile; CI's warm nimcache skips gcc entirely, so what you can still make slower is the frontend (imports) and the run. A test must never wait out a real runtime interval: stub the hook instead (`setMetricsHooksForTest(sleepHook = …)`, the chromium app's `chromiumSettleHook` is already a no-op under `-d:testing`, `RunnerThread.stopMessageLoop` ends `startMessageLoop` instead of letting `maxIterations` run out at 200 ms a pass). Before that, three tests were 140 s of the suite's 240 s of run time (2026-10-11).

## The hardware bench: `.claude/skills/frame-bench/SKILL.md`

- `tools/frame-bench/bench.py` benches every frame on the machine's USB
  (ESP32 boards and Pico thin clients attached to a local backend): every
  scene, the desktop layouts with windows open, input, switch storms, a memory
  soak, a hanging backend, reboots and server rendering. It reports crashes,
  OOMs, watchdogs, slow paths (an LCD that stops drawing in place, a switch
  that waits on a backend round trip) and regressions against an earlier run
  (`--baseline`). Run it after a firmware change that touches rendering,
  scenes, layouts or the backend link, on the frames attached.
- It holds every serial port open with pyserial's defaults: a CH340 board
  resets when DTR and RTS flip one at a time, so never set them by hand.
- **The boards are shared between sessions: book one before you touch it**
  (its console, a flash, a push, a bench): `tools/frame-bench/boards.py book
  <board> --who "<your session> (...)" --for "..."`, release it when done, and
  never use one someone else holds (`~/.frameos-bench/BOOKINGS.md`; the
  skill's "Booking a board"). `bench.py run` and the flashing scripts book,
  wait and skip by it.
- **How scenes look and behave on each board, without the boards:**
  `tools/ux-bench` (its README) runs every sample in the wasm runtime as each
  bench board's runtime runs (size, rotation, panel format, round glass,
  keys, event map, touch, memory ceiling), presses and holds every key,
  swipes every edge, taps what the press map says takes a tap, scrolls, and
  holds the outcomes to the board's event map; contact sheets per panel for
  the eye. Run it after a change to samples, layouts, the built-in scenes,
  render scale or input; `device_ux.py` checks swipes and keys on real boards.

## End-to-end tooling
- `e2e/README.md` is the map of every end-to-end suite: the scene-renderer snapshot harness (`e2e/run`, `makescenes.py`, `makesnapshots.py`, baselines in `e2e/snapshots`; `./run dataGradient` renders one scene), the Playwright frontend + cloud-workspace suite (`e2e/frontend-visual`), the opt-in real-SSH deploy test (`e2e/deploy`) and the Docker/ESP32 image jobs. It also carries the local-run recipes (port overrides, `FRONTEND_VISUAL_MAX_DIFF=1`, why a reused server drifts).
- CI spends no money: the repository is public, so GitHub-hosted runners and GHCR are free, and the compute-heavy jobs run on the self-hosted pool (`tools/gha-runners/README.md`). Container images build with buildx against registry layer caches under `ghcr.io/frameos/frameos-build-cache` (`esp32-ci`, written by `e2e-docker.yml` on pushes to main and read by every other build of that target; `runtime-<arch>`, per release). A new image build in a workflow reads one of those caches or adds a tag there — never a paid builder (Depot was removed 2026-11), and never QEMU for the runtime image: build each platform natively (epyc-8 / `ubuntu-24.04-arm`) and merge by digest, as `build-runtime-image` + `push-multiarch` do.
- Do not run frontend visual regression tests (`e2e/frontend-visual`, Playwright screenshots, or snapshot updates) during normal iteration. Only run them when the user explicitly asks for visual tests or asks to commit changes.
- Never commit visual regression snapshot updates produced by a backend/frontend stack running locally. Local macOS font rendering and browser rasterization differ from CI's Linux environment, so CI is the source of truth for both snapshot sets: same-repo pull requests run with `--update-snapshots` and the "Commit Visual Regression Snapshots" / "Commit Frontend Visual Snapshots" jobs push the result to the PR branch as "FrameOS Bot" (so `git pull --rebase` before pushing again). A visual job that fails on CI is therefore never a pixel diff — read the log for the frontend-error assertion or the failing `prepare` step.

## Deployment & operations
- Docker support: top-level `docker-compose.yml` builds the full stack (backend plus dependencies) exposing port 8989 and persisting SQLite DB under a named volume. SQLite is the self-hosted backend's only supported database: `DATABASE_URL` is settable because the backend uses SQLAlchemy, but no other engine is tested and no other driver ships. (The cloud's Postgres is a separate stack under `cloud/`.) Backend Postgres support was briefly documented in September 2026 and withdrawn — do not re-add it without someone who actually needs it.
- The root `Dockerfile` is multi-stage: `runtime` is the published backend image (`docker build --target runtime -t frameos .`, what `README.md` and CI's "Build Docker Image" job build), `esp32-ci` is the ESP-IDF + Nim toolchain image the ESP32 firmware job builds in, and `app-builder` / `nim-toolchain` / `python-deps` are its intermediate stages. The plain runtime container is all a normal install needs; the Docker socket + `--privileged` variant in `README.md` exists only for the deprecated per-frame source build (`docs/legacy-source-builds.md`). Watchtower example commands in `README.md` show daily update flows.
- Environment variables documented in backend config govern integration with Home Assistant (HASSIO), Redis, PostHog analytics, and secret management. 【F:README.md†L24-L71】【F:backend/app/config.py†L1-L86】

## Getting started quickly
1. Install JS deps once from the repo root (`pnpm install`) and build the frontend (`pnpm --dir frontend run build`).
2. Install backend deps (`cd backend && pip install -r requirements.txt`).
3. Launch the local development stack with `pnpm dev`, or run the API (`uvicorn app.fastapi:app --reload`) and background worker (`arq app.tasks.worker.WorkerSettings`) separately if needed.
4. Optionally bring up the stack via Docker (`docker compose up --build`).
5. Use the backend UI/API to manage frames, deploy scenes, and monitor logs.

Keep this file updated as architecture or workflows change so future agents have an accurate snapshot of the repository.
