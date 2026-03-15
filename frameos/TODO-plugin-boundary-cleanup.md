# FrameOS Plugin Boundary Cleanup

## Purpose

This file is the handoff and working plan for reducing duplicated code and heavyweight dependencies across the FrameOS main app, compiled scenes, and compiled drivers.

If a future run is told to "continue the plugin boundary cleanup" or is pointed at this file, it should:

1. Read this file first.
2. Verify the current code still matches the assumptions below.
3. Continue from the highest-priority unchecked item.
4. Update this file before ending the run:
   - mark completed items
   - add new findings
   - adjust sequencing if the code changes
   - leave a short "Last session notes" entry

Do not treat this as a static brainstorm doc. It is the canonical recursive todo for this cleanup.

## Goal

Make compiled scenes and compiled drivers thin plugins.

Specifically:

- Keep shared rendering/runtime logic in the main `frameos` app where possible.
- Stop making every scene/driver plugin statically bundle large transitive dependencies when the host can own them.
- Move preview/serialization work like PNG encoding out of drivers and into the host runtime.
- Reduce unnecessary `pixie` coupling for data/logic-only code.

## Current Architecture Snapshot

### Compiled scenes

- Compiled scenes are built as separate `.so` libraries by [frameos/tools/build_compiled_scenes.py](/Users/marius/Projects/FrameOS/frameos/frameos/tools/build_compiled_scenes.py#L18).
- Generated scene sources import the concrete app modules they use directly in [backend/app/codegen/scene_nim.py](/Users/marius/Projects/FrameOS/frameos/backend/app/codegen/scene_nim.py#L852).
- Example emitted scene code does this in [frameos/src/scenes/default.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/scenes/default.nim#L12).
- The runtime loads compiled scene plugins via `dlopen` in [frameos/src/frameos/scenes.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/scenes.nim#L55).

### Interpreted scenes and shared app runtime

- The main runtime already imports the full app registry for interpreted/uploaded scenes in [frameos/src/frameos/interpreter.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/interpreter.nim#L1).
- The app registry imports every generated app loader in [frameos/src/apps/apps.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/apps.nim#L1).

### Drivers

- Driver plugins are loaded via `dlopen` in [frameos/src/drivers/plugin_runtime.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/drivers/plugin_runtime.nim#L61).
- Driver ABI now exposes `render(image)` and optional preview artifacts in [frameos/src/frameos/types.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/types.nim#L326).
- The host runtime reconstructs preview images from driver artifacts in [frameos/src/drivers/plugin_runtime.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/drivers/plugin_runtime.nim#L118).
- The web API encodes PNG in host code only, preferring a reconstructed driver preview image over the host-rendered last image in [frameos/src/frameos/server/api.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/server/api.nim#L261).
- The host still knows how to encode the last rendered image to PNG in [frameos/src/frameos/scenes.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/scenes.nim#L478).

### Type coupling

- `frameos/types.nim` imports `pixie` and exposes `Image` and `Color` in the shared ABI surface in [frameos/src/frameos/types.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/types.nim#L130).
- Generated app loaders always import `pixie` in [backend/app/codegen/app_loader_nim.py](/Users/marius/Projects/FrameOS/frameos/backend/app/codegen/app_loader_nim.py#L627), even when an app is string/json-only.

## Confirmed Problems

### 1. Scene plugins duplicate app code

Because generated compiled scenes import concrete app modules directly, app implementations get linked into every compiled scene plugin, while the host binary also contains the shared app runtime for interpreted scenes.

Impact:

- larger scene `.so` files
- duplicate compile time
- duplicate code in memory and artifacts
- tighter coupling between scene codegen and app implementations

### 2. Driver plugins own preview serialization that the host should own

The old `toPng` path caused drivers to reconstruct images and encode PNG themselves.

Confirmed examples:

- [frameos/src/drivers/waveshare/waveshare.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/drivers/waveshare/waveshare.nim#L208)
- [frameos/src/drivers/inkyPython/inkyPython.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/drivers/inkyPython/inkyPython.nim#L224)

This is unnecessary because:

- the host already has the last rendered RGBA image
- the host already has PNG encoding code
- drivers already hold lower-level dithered/indexed/raw buffers that are cheaper to return than PNG

### 3. `pixie` leaks into non-image code

Many data/logic apps that do not fundamentally need image manipulation still import `pixie`, directly or indirectly.

Examples of likely unnecessary imports:

- [frameos/src/apps/data/openaiText/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/openaiText/app.nim#L1)
- [frameos/src/apps/data/icalJson/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/icalJson/app.nim#L1)

Some apps do need colors but not full image support:

- [frameos/src/apps/data/eventsToAgenda/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/eventsToAgenda/app.nim#L1)

### 4. Plugin ABI is too high-level

Scenes and drivers currently exchange full Nim runtime objects like `FrameScene`, `FrameOS`, `JsonNode`, `Value`, and `Image` across plugin boundaries via [frameos/src/frameos/types.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/types.nim#L151).

This is convenient but makes plugins depend on the host's full object graph instead of a narrow ABI.

## Target Direction

### Short version

- Host owns shared runtime, shared app logic, and final serialization.
- Scene plugins should mainly describe scene structure and scene-local compiled logic.
- Driver plugins should mainly talk to hardware and optionally return compact preview artifacts, not PNG.
- Shared types should be split so non-image code does not pull in `pixie` by default.

### Preferred sequence

1. Fix driver preview boundary.
2. Split core types from image/render types.
3. Make app loaders import `pixie` only when needed.
4. Thin compiled scenes so they stop statically bundling app implementations.
5. Optionally narrow the ABI further to callback tables + opaque handles.

## Non-Goals

- Do not rewrite the entire scene system in one pass.
- Do not remove interpreted scenes.
- Do not break current deploy/cross-compile flows while optimizing boundaries.
- Do not optimize for a "compiled-only minimal host" unless product direction changes explicitly require it.

## Work Plan

### Phase 1: Move driver preview serialization into the host

Status: `in_progress`

#### Intended outcome

Replace `canPng` / `toPng` with a preview-artifact boundary owned by the host.

#### Recommended design

Introduce a new driver preview type in the shared ABI, for example:

- `dpfRgba8`
- `dpfGray8`
- `dpfIndexed2`
- `dpfIndexed4`
- `dpfIndexed8`
- `dpfMono1`

And a payload object containing:

- width
- height
- optional rotate hint
- pixel format
- raw bytes
- optional palette

The host should then:

- request preview artifact from the driver, if available
- reconstruct a preview image in one place
- encode PNG in the host for the web API

#### Concrete tasks

- [x] Replace `canPng` / `toPng` in [frameos/src/frameos/types.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/types.nim#L326) with a host-owned preview artifact API.
- [x] Update [backend/app/codegen/drivers_nim.py](/Users/marius/Projects/FrameOS/frameos/backend/app/codegen/drivers_nim.py#L38) to emit the new driver plugin ABI.
- [x] Update [frameos/src/drivers/plugin_runtime.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/drivers/plugin_runtime.nim#L118) to consume preview artifacts instead of PNG strings.
- [x] Update [frameos/src/frameos/server/api.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/server/api.nim#L261) so PNG encoding happens in host code only.
- [x] Convert `waveshare` to return dithered/indexed/raw preview data instead of PNG.
- [x] Convert `inkyPython` to return raw preview data instead of PNG.
- [x] Re-check whether any other drivers still need preview support at all.
- [x] Keep `httpUpload` as host-image or driver-local encoding only if it is strictly part of device output, not API preview.

#### Verification

- [ ] `GET /api/frame/image` still returns correct previews for framebuffer-only frames.
- [ ] `GET /api/frame/image` still returns correct previews for Waveshare frames after dithering.
- [ ] `GET /api/frame/image` still returns correct previews for Inky preview-capable frames.
- [x] Driver plugins no longer expose PNG encoding functions.

#### Findings from implementation

- Packed indexed preview data must be decoded row-by-row, not as a single continuous packed bitstream, because driver outputs pad each row independently.
- Current compiled drivers that actually need API preview artifacts are `waveshare` and preview-enabled `inkyPython`; framebuffer, HyperPixel, GPIO, EVDEV, and `httpUpload` do not.

### Phase 2: Split pixie-free core types from image/render types

Status: `todo`

#### Intended outcome

Allow non-image code to compile without importing `pixie`.

#### Recommended design

Split the current `frameos/types.nim` into layers, for example:

- `frameos/types_core.nim`
  - ids
  - config
  - logger
  - scene metadata
  - driver/plugin metadata
  - event hooks
  - JSON-centric state
- `frameos/types_image.nim`
  - `Image`
  - `Color`
  - image-bearing `Value` cases
  - render-specific context fields

The exact file names can change, but the dependency direction should be:

- core types do not import `pixie`
- image/render layers may import core + `pixie`

#### Concrete tasks

- [ ] Design the split for [frameos/src/frameos/types.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/types.nim#L1) without breaking too many imports at once.
- [ ] Separate `Color` usage from full `Image` usage where practical.
- [ ] Audit `Value` and decide whether image-bearing values need to stay in the universal value union or move to a render-specific layer.
- [ ] Audit `ExecutionContext` and decide whether `image` should remain inline or move behind a narrower render context abstraction.
- [ ] Update imports across runtime, scenes, drivers, and apps.

#### Verification

- [ ] String/json-only modules no longer import `pixie` transitively.
- [ ] Image/render modules still compile cleanly.
- [ ] Tests for interpreter, apps, and drivers still pass.

### Phase 3: Make generated app loaders only import what they need

Status: `todo`

#### Intended outcome

Stop unconditional `pixie` imports in generated loaders.

#### Concrete tasks

- [ ] Update [backend/app/codegen/app_loader_nim.py](/Users/marius/Projects/FrameOS/frameos/backend/app/codegen/app_loader_nim.py#L627) so `pixie` is only imported when the app config or generated setter/getter code actually uses image/color/image-option types.
- [ ] Distinguish at least:
  - string/text/json/integer/float/boolean-only apps
  - color-only apps
  - image-bearing apps
- [ ] Regenerate `app_loader.nim` files and verify diff quality.
- [ ] Re-audit apps that directly import `pixie` but likely do not need it.

#### Suggested first audit targets

- [ ] [frameos/src/apps/data/openaiText/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/openaiText/app.nim#L1)
- [ ] [frameos/src/apps/data/icalJson/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/icalJson/app.nim#L1)
- [ ] [frameos/src/apps/data/eventsToAgenda/app.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/apps/data/eventsToAgenda/app.nim#L1)

#### Verification

- [ ] Regenerated loaders compile.
- [ ] No behavior change for app initialization or field setting.
- [ ] Reduced number of unconditional `import pixie` sites in generated code.

### Phase 4: Thin compiled scenes so they stop bundling app implementations

Status: `todo`

#### Intended outcome

Compiled scenes should stop importing concrete app modules directly.

The host already has shared app execution machinery for interpreted scenes. Compiled scenes should reuse that instead of statically linking app implementations into each scene plugin.

#### Recommended direction

Move compiled scenes toward one of these models:

Option A, preferred:

- compiled scene plugin exports scene graph / initialization plan / precompiled wiring
- host instantiates and runs app implementations from shared host code
- only scene-local compiled code paths remain inside the plugin

Option B:

- compiled scene plugin exports a lighter executable IR
- host runtime interprets that IR against shared app registry

Avoid:

- keeping per-scene direct imports of concrete app modules as in [frameos/src/scenes/default.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/scenes/default.nim#L12)

#### Concrete tasks

- [ ] Decide the minimal artifact a compiled scene should export.
- [ ] Update [backend/app/codegen/scene_nim.py](/Users/marius/Projects/FrameOS/frameos/backend/app/codegen/scene_nim.py#L852) so generated scene plugins stop importing app modules directly.
- [ ] Reuse shared host app initialization/execution paths where possible.
- [ ] Keep scene-local constants, node order, caches, and event wiring in plugin-exported data.
- [ ] Decide how code nodes / inline compiled snippets fit into the new boundary.
- [ ] Revisit [frameos/src/frameos/scenes.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/scenes.nim#L55) if the plugin export shape changes.

#### Verification

- [ ] Compiled scenes still load and render.
- [ ] Scene `.so` files shrink materially.
- [ ] Host behavior remains consistent between compiled and interpreted scenes.

### Phase 5: Narrow the plugin ABI further

Status: `todo`

#### Intended outcome

Reduce direct sharing of host runtime objects across plugin boundaries.

#### Direction

Reuse the callback-table pattern already present in [frameos/src/frameos/channels.nim](/Users/marius/Projects/FrameOS/frameos/frameos/src/frameos/channels.nim#L63):

- expose a small host API table
- let plugins keep opaque plugin-owned state
- avoid exposing broad host object graphs when not necessary

#### Concrete tasks

- [ ] Inventory which plugin operations truly need `FrameOS`, `FrameScene`, `Image`, and `JsonNode`.
- [ ] Move easy cases to explicit callback/table-based APIs first.
- [ ] Leave deeper ABI cleanup until after Phases 1 to 4 stabilize.

## Success Criteria

The cleanup is successful when most of the following are true:

- Driver plugins no longer encode PNG for the web API.
- The host is the single place that produces API preview PNG.
- Data/logic-only code can compile without `pixie`.
- Generated app loaders stop unconditionally importing `pixie`.
- Compiled scenes no longer statically bundle concrete app implementations.
- Compiled scene artifacts are materially smaller than before.
- The runtime behavior for rendering, previewing, and deploying remains unchanged from a user perspective.

## Measurements To Capture During Implementation

Capture before/after numbers and write them here as work progresses.

- [ ] Count of `import pixie` sites in `frameos/src`
- [ ] Size of representative scene plugins in `frameos/scenes/*.so`
- [ ] Size of representative driver plugins
- [ ] Build times for:
  - main `frameos`
  - compiled scenes
  - compiled drivers

## Known Open Questions

- Should color-only types remain coupled to `pixie.Color`, or should FrameOS define a lightweight own color type and convert at render boundaries?
- Should `Value` keep an `fkImage` branch globally, or should image values be moved out of the universal union?
- Should compiled scenes remain `.so` plugins at all, or is a generated IR/source artifact loaded by the host enough?
- Is there any product requirement for driver-specific preview output that differs from host-side preview of the last rendered image?
- Is a dedicated "compiled-only lean host" a real target, or just a theoretical alternative?

## Last Session Notes

### 2026-03-15

- Implemented the Phase 1 driver preview ABI change: `canPng` / `toPng` became `canPreview` / `preview` with a typed `DriverPreviewArtifact`.
- Moved preview reconstruction into host code in `drivers/plugin_runtime.nim` and left PNG encoding only in the server API path.
- Converted `waveshare` and preview-capable `inkyPython` to cache raw preview artifacts instead of encoding PNG inside the driver.
- Added host-side preview decode coverage in `src/frameos/server/tests/test_api.nim` and updated Python codegen coverage in `backend/app/codegen/tests/test_drivers_nim.py`.
- Verified with:
  - `pytest app/codegen/tests/test_drivers_nim.py`
  - `nim c -r --nimcache:./nimcache/test_api_preview src/frameos/server/tests/test_api.nim`
  - `nim c -r --nimcache:./nimcache/test_inky_preview src/drivers/inkyPython/tests/test_helpers.nim`
  - `nim c -r --nimcache:./nimcache/test_waveshare_preview src/drivers/waveshare/tests/test_types.nim`
- Remaining Phase 1 work is end-to-end preview verification for framebuffer, Waveshare, and Inky frame image responses.

## Next Recommended Starting Point

Finish Phase 1 verification before moving on to the type split.

Specifically:

1. Exercise `GET /api/frame/image` on a framebuffer-only frame and confirm host-last-image fallback still works.
2. Exercise `GET /api/frame/image` on Waveshare and preview-capable Inky hardware or fixtures and confirm the decoded artifact matches the dithered result.
3. Capture before/after size numbers for representative driver plugins now that PNG encoding code is gone.
4. Once those checks are done, start Phase 2 and split pixie-free core types from image/render types.

Do not start with the compiled scene rewrite first. That is the larger change and will be easier once the driver preview boundary is cleaned up and the type split is clearer.
