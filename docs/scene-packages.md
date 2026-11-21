# Scene packages: should a scene be a .zip instead of scenes.json?

*An investigation (2026-11-20). Nothing here is built yet. The numbers come
from `frameos/tools/measure_scene_packages.py` (sizes, SPIFFS footprints, a
replay of the samples' git history) and `frameos/tools/scene_parse_probe.nim`
(the heap a Linux runtime spends reading a set). Both are quoted with the
command that produced them, so they can be run again after the samples
change.*

The owner asked: "we now store scenes as scenes.json files, but investigate if
storing them as .zip would come with some benefits. all apps, etc, would be in
their own files, and we probably want to start loading assets in there one
day."

**The short answer.** Yes, split a scene into files. Do not make zip the
storage format everywhere. The scene stays a JSON object in every API and
editor. A **package layout** (`scene.json`, `apps/<app>/<file>`,
`code/<node>.js`, and later `assets/<path>`) becomes the one pinned way to
lay that object out as files. Zip is the container for that layout wherever
one file or one message is wanted: store versions, template downloads, and
later an ESP32 slot file. A directory holds it wherever a filesystem has
directories: the repo's samples and a Pi. scenes.json stays as the
compatibility form for runtimes and firmware that predate packages.
Compression is a separate decision and needs no zip. The phased plan is at
the end.

## What a scene is made of today

`python3 frameos/tools/measure_scene_packages.py` reads every repo scene
(`repo/scenes/samples` and `repo/scenes/gallery`): 116 scenes in 112 folders.

| | Whole set |
| --- | ---: |
| Compact JSON, as both planes send it | 3,585 KB |
| Pretty JSON (indent 4), the Pi's scenes.json | 4,217 KB |
| ... gzipped whole, the Pi's scenes.json.gz | 1,033 KB |
| Compact JSON, deflated one scene at a time | 1,073 KB |
| Compact JSON with `*.test.*` stripped (what an ESP32 is sent) | 3,531 KB |

Each scene split into the Code editor's files (`filesOf` in
`repo/scenes/samples/Code editor`):

| Part | Bytes | Share |
| --- | ---: | ---: |
| Graph: `scene.json` without apps and code | 418 KB | 12.3% |
| JS app files (`apps/<app>/<file>`) | 2,965 KB | 87.6% |
| ... of which app tests (`*.test.*`) | 53 KB | |
| Code nodes' code (`code/<node>.js`) | 3 KB | 0.1% |
| JSON string escaping of those sources | 199 KB | 5.9% on top |

- **A scene is mostly its apps' source.** 104 of the 116 scenes carry JS
  apps, and in those scenes the apps are 89% of the bytes.
- **Per-scene sizes:** median 24.8 KB, p90 70.7 KB, largest 93.0 KB
  (Calendar).
- **Entries:** a package would hold a median of 3 entries and at most 19.
- **The largest single files are the desktops' `app.tsx`,** 64-78 KB each.
- **Data written as code:** Visited World Map's `countries.tsx` is 63 KB of
  SVG path strings kept as a TypeScript constant. A scene has nowhere else to
  put data, so this is an asset dressed as code.

## Where scenes live today

### The Pi (Linux runtime)

**Deployed set**

- The backend writes `json.dumps(scenes, indent=4)`, gzipped, as
  `scenes.json.gz` into the release directory. A fast deploy writes it to
  `/srv/frameos/current` (`backend/app/tasks/_frame_deployer.py:278`,
  `frame_deploy_workflow.py:1464-1521`) and then POSTs `/reload`.
- The runtime reads the whole file, gunzips it, and hands the text to the
  scene reader (`interpreter.nim` "Reading scenes.json",
  `loadInterpretedScenesFromDisk`).
- The reader is a hand-written key loop. It reads the graph into types and
  each scene's `apps` map as a std/json tree (`of "apps": result.apps =
  readJson(s, i)`).
- That tree, with every app's every source string in it, stays in
  `ExportedInterpretedScene.apps` for as long as the scene is loaded. A Pi
  loads every scene at startup.

**Uploaded set**

- A preview, a cloud `set_scenes` or the scene store reaches the runtime as
  one `uploadScenes` event with the whole list.
- The path is `scenes.nim` `updateUploadedScenesFromPayload`:
  1. The HTTP body is parsed by std/json.
  2. It is turned back into text (`$scenePayload`).
  3. The scene reader reads that text.
  4. The text is kept for good (`setUploadedScenePayload`).
  5. It is also written as `state/uploaded.json`, uncompressed.

**Code editor and scene store hosts**

- They read `uploaded.json` and the deployed payload whole for every request
  (`scene_code_linux.nim` `heldScenes`, `scene_store_linux.nim`).
- The store host installs a scene by fetching the store's
  `/api/store/scenes/<id>/scenes.json`, not its zip.

### What reading a set costs on a Pi

`frameos/tools/scene_parse_probe.nim` was run on the whole sample set
(x86_64, ORC, `-d:release`). Its inputs come from
`measure_scene_packages.py --probe-inputs`.

| Path | Input | Peak heap | Held after |
| --- | ---: | ---: | ---: |
| Deployed (scenes.json read and parsed) | 4,216 KB text | 12.5 MB | ~6.0 MB of built scenes (10.0 MB with the text) |
| Same set with app sources emptied | 1,140 KB text | 5.1 MB | ~2.6 MB |
| Upload (std/json, `$`, reader, build) | 3,628 KB body | 30.9 MB | 24.7 MB until the tree goes |

**What the numbers say**

- App sources account for about 3.3 MB of what a Pi keeps resident for this
  set. That is roughly their own size: they sit in JSON trees that nothing
  reads until an app's interpreter starts.
- An upload of the same set peaks at 2.5 times the deployed path. The
  std/json tree alone is 13.8 MB.
- This does not matter on a 512 MB Pi with a handful of scenes. It is the
  first thing to go if a Pi ever holds the whole store, and it is pure
  overhead.

### The ESP32 (`embedded/esp32/README.md` "Scene storage")

**On flash**

- One file per scene: `/state/scene-<slot>.json` holds the scene as it
  arrived. `scene-index.json` holds ids, names, intervals, icons, hashes and
  slots (`main/fos_scene_store.c`, 128 scenes in 256 slots).
- Slot numbers stand in for names because `CONFIG_SPIFFS_OBJ_NAME_LEN` is 32.
  SPIFFS has no directories.
- A changed scene goes to a new slot and the index is switched. A slot is
  never overwritten in place.

**On the wire**

- Scenes arrive as JSON, either the whole list or a per-scene patch:
  - the backend's `/embedded/scenes?patch=1`, `{"patch", "base", "order",
    "put": [whole scenes]}`;
  - the cloud's `scenes_patch`, `{"base_checksum", "order", "put"}`;
  - for a set over 512 KiB, parts (`nextScenesPart`).
- Nothing is compressed on the way:
  - the firmware sends no `Accept-Encoding` on its backend pull;
  - the hub sends JSON text frames.
- Both planes strip `*.test.*` app sources for an ESP32 (`retired-apps.ts`
  `scenesForEmbeddedRuntime`, `backend/app/utils/retired_apps.py`).
- A backend answer too big to hold is read straight into slot files
  (`fos_scene_pieces_read_to`, the `stage` calls). The index fields come off
  the bytes as they pass (`fos_scene_meta.c`). In memory a set is never more
  than 512 KB (`SCENES_HELD_MAX_BYTES`).

**Loading a scene**

- The render task reads the active scene's file whole and parses it in place
  (`parseInterpretedSceneInput`).
- Its `apps` tree, with every source string in it, stays while the scene is
  resident.

**Flash used**

- The whole sample set is 3,722 KB of `/state` (256 B pages), using
  `fos_spiffs_footprint.c`'s page arithmetic.
- An 8 MB board's `/state` is 1 MB. The reTerminal E1002 holds 17 scenes,
  680 KB.

**Inflaters and a zip reader already in the image**

- The ROM's `tinfl` is used for FOSB v2 pictures (`fos_client.c`): a 32 KiB
  window plus about 11 KB of state while it runs, and no flash.
- pixie's streaming inflater (`pixie/inflatestream.nim`, 5,232 B) is used for
  PNG.
- **A zip member reader** (`frameos/utils/zip_entry.nim`, 6,478 B on the S3
  image, measured by #863's firmware-size comment) is already there:
  - It handles the central directory, stored and deflated members, and data
    descriptors.
  - It inflates through pixie's inflater, about 64 KB fixed while it runs.
  - It was tuned on a Sticky's SPIFFS: one open per call, the end record
    found in the last 4 KB, the last directory cached.
  - The Books scene reads EPUB chapters with it, and JS apps reach it as
    `readAsset(path, {entry})` and `loadAssetImage(path, {entry})`.

### The backend

**Frames**

- `frame.scenes` is a JSON column holding the list (`models/frame.py:492`).
- Installed-copy extras sit beside each scene: `origin`, `default`,
  `eventMap`, `layout`.
- The SPA saves the whole frame with every scene in it
  (`POST /api/frames/{id}`). So do the iOS app and the MCP
  `frame_scene_update`.

**`/embedded/scenes` for an ESP32**

- The payload is compact JSON with `sort_keys=True`. Its ETag is the payload's
  sha256.
- The patch base lives in Redis: `frame:{id}:embedded_served_scenes`, holding
  the ETag and `{sceneId: sha256(canonical scene)}`.
- The answer is one buffered response (`api/embedded_device.py:1520-1676`).

**Templates (saved scenes)**

- A template row holds the scenes as a JSON column and its cover as a blob
  (`models/template.py`).
- **The template zip already exists:**
  - `template_zip_bytes` writes `<name>/template.json`, `<name>/scenes.json`
    and `<name>/image.jpg`, deflated (`api/templates.py:125-191`).
  - `parse_template_zip` reads it back.
  - It is used by "Download as .zip", template upload and URL import, and the
    cloud backups (one zip per template in a tar.gz).
  - Every reader ignores any other entry.

**Repo samples**

- `repo/scenes/samples/<Name>/{template.json, scenes.json, image.jpg}`,
  served by `api/repositories.py`. The repo is therefore an unzipped template
  zip.

### The cloud

**Store versions**

- A store version is a zip, immutable and content-addressed
  (`store/scene-versions/<sha256>.zip` in R2, row in `store_scene_versions`).
- It holds the same three entries as the backend's template zip: `template.json`,
  `scenes.json` (pretty, indent 2) and the cover as `image.jpg`. App sources
  live inside `scenes.json` (`account-scene-create.ts` `buildSceneZip`,
  `store.ts` `rebuildZip`, fflate `zipSync` with default deflate).
- **Reading:**
  - `readBlob` loads the whole object.
  - `unzipBounded` (`zip-bounded.ts`, a hand-written central-directory reader)
    inflates only `scenes.json`.
  - Retired apps are converted when a version is read, because "zips are
    immutable" (`retired-apps.ts`).
- Every save writes a whole new zip, including the Code editor's
  `panel-code.ts` and the editor's content route.

**Frames**

- An assignment (`frame_scene_assignments`) references a store version. It
  holds no scene JSON. `event_maps` and `layouts` are columns on the row.
- A push is built by reading each version's zip, extracting `scenes.json`,
  stamping origin, event map and layout, and converting retired apps
  (`frames.ts` `buildScenesPayloadForFrame`).
- The push is queued as a `set_scenes` row with the scenes inline in jsonb.
  `scene_hashes` holds `sha256(JSON.stringify(scene))` per scene.
- **Patches and parts:**
  - `scenes_patch` sends whole changed scenes in `put`.
  - `nextScenesPart` splits a set over 512 KiB into parts of about 256 KiB,
    each with its own checksum.
  - A single scene over the cap is refused.
- **Frames are never sent a zip.**

### Everything else

**The editor**

- `SceneEditorBody` / `SceneFileTree` already show a scene as a virtual file
  tree: the diagram, and a folder per app.
- `editAppLogic` edits `sources` as `{file: text}`.

**AI and MCP tools**

- The AI tools (`patch_scene`, `edit_app_source`) address
  `apps.<kw>.sources.<file>` on both planes.
- The MCP tools take and return scene JSON. `frame_scene_install` also takes
  a URL to a zip or a scenes.json.

**The wasm preview** is handed the whole set as one JSON string
(`frameos_wasm_load_scenes`). It is rebuilt when any scene changes.

**The iOS app** keeps scenes as opaque `JSONValue` and has no zip code.

**The Code editor scene** (`docs/code-editor.md`)

- It gets a scene's JSON text from `frameos.code("source")`.
- It splits it into files in JavaScript (`filesOf`: `scene.json`,
  `<app>/<file>`, `code/<node>.js`) and joins them again before it saves the
  whole scene.

**Conclusion: the file layout already exists three times.** The editor's tree,
the Code editor's `filesOf` and the AI tools' paths each have one, and they
disagree in small ways (`<app>/<file>` against `apps/<kw>/<file>`). Every
container that exists (the template zip, the store zip, scenes.json.gz) holds
the scene as a single JSON entry.

## What a zip would buy

**Each file stored as itself.**

- No JSON escaping (199 KB, 5.9% of the sources).
- A desktop's 78 KB `app.tsx` stops being one 80 KB line in git:
  - 86 lines in `repo/scenes/samples/*/scenes.json` are over 10 KB;
  - the longest is 80,196 characters;
  - today a one-character change to an app is a diff of that whole line.

**Patches by file instead of by scene.**

- The last 89 commits that changed a sample made 612 scene changes. 355 of
  them (58%) touched only the graph.
- Sent as today's per-scene patch they are 17.0 MB, 4.9 MB deflated.
- Sent as the changed entries alone they are 9.6 MB, 2.9 MB deflated, about
  44% less.
- A graph-only change to a desktop sends its 2 KB `scene.json` instead of
  80 KB.
- This needs no zip on the wire: a patch can name files inside JSON just as
  well. The package layout is what makes "a file" mean the same thing on both
  ends.

**Reading one entry without the rest.**

- The central directory says where each file is.
- A runtime could parse `scene.json` (the 12%) at load and read an app's
  sources only when its interpreter starts.
- On a Pi that is the ~3.3 MB resident above. The 31 MB upload peak is
  today's std/json-then-text path, not the format: an upload that arrives as
  a package (or is read by the scene reader directly) loses it too.
- On an ESP32 the active scene's sources leave the parsed tree: up to 75 KB
  for Calendar. They would be read again from flash each time an interpreter
  is rebuilt (`settleIdleJsAppRuntimes`, deep sleep). That costs a SPIFFS
  open plus the read (or an inflate) per rebuild, so keep the slot file's
  descriptor open while the scene is resident (`max_files` is 8).

**Compression by entry.**

- Deflate takes the set from 3,585 KB to 1,172 KB as one deflated zip per
  scene.
- Most of that comes from deflate, not from zip. Deflating each scene's JSON
  whole is 1,073 KB, 9% smaller than per-entry deflate, because small entries
  compress worse and each entry pays 76 bytes plus its name twice.
- On the Pi the deployed set is already gzipped. Compression would be new
  only for `state/uploaded.json`, the ESP32's flash and wire, and the hub's
  messages.

**SPIFFS footprint of the set** (`fos_spiffs_footprint.c`'s arithmetic, 256 B
pages):

| One slot file a scene, as | /state used | Files |
| --- | ---: | ---: |
| JSON (today) | 3,722 KB | 116 |
| Stored zip | 3,582 KB | 116 |
| Zip with `scene.json` stored and the rest deflated | 1,534 KB | 116 |
| Deflated zip | 1,240 KB | 116 |
| Each entry unpacked into its own file | 3,656 KB | 514 |

- A deflated slot file would put about three times as many scenes on a 1 MB
  `/state`.
- Unpacking into one file per entry saves nothing and needs 514 files against
  256 slots.

**Assets inside a scene.**

- The motivating case. Visited World Map's 63 KB of country outlines are
  written as TypeScript because a scene cannot carry data. The same goes for
  every "bundled anthology / collection / deck" idea in
  `docs/scenes-todo.md`, and for any scene that wants its own picture, font
  or sound.
- An `assets/` entry is read in place by the reader the firmware already has
  (`readAsset(path, {entry})`, streaming, a slice at a time) and decoded at
  size by `loadAssetImage(path, {entry})`.
- Today `/srv/assets` is the frame's folder, synced separately (fonts on
  deploy, the Assets panel, `asset_put` on the cloud). No asset ever travels
  with a scene.

**Hashing by entry.** Content hashes per file give:

- patches that name a hash, not a whole scene;
- a cache key for compiled bytecode per app file;
- deduplication across scenes. Kept once by content hash, the set's
  non-test entries go from 3,334 KB to 2,852 KB (−14.5%). The duplicates are
  the games' shared `ui.ts` / `input.ts` / `gfx.ts`, the iCal app in four
  scenes, the two remotes' `ui.tsx`.

**Parity with the store.** The store is already a zip. A package layout inside
the same container lets a version be read by file (only the files a frame
needs) and diffed by file between versions.

## What it costs

**Flash on the ESP32**

- The reader is already in the image: 6.5 KB for `zip_entry.nim` and 5.2 KB
  for pixie's inflater, and the ROM `tinfl` is free.
- Each of these would be new:
  - reading a scene's `scene.json` and apps from a slot file through
    `zip_entry`;
  - teaching `fos_scene_meta.c` to find `scene.json` in a zip;
  - in C, rewriting a package with one entry changed: copy the other
    entries' compressed bytes through, new local headers, a new central
    directory, CRC-32 from the ROM.
- **Estimate: 3-8 KB in all. Not built, not measured.** The image is at
  about 91% of the 8 MB layout's 3,520 KB slot (`docs/esp32-image-size.md`).
- Receiving deflated data on the wire through ROM `tinfl` costs nearly no
  flash. `fos_client.c` does it for FOSB v2 already.

**RAM on the ESP32**

| Item | Cost |
| --- | --- |
| Inflate, ROM `tinfl` | 32 KiB window + ~11 KB state, while it runs |
| Inflate, pixie's inflater (as `zip_entry` uses today) | ~64 KB fixed |
| Stored entries | no inflate cost at all |
| Central directory (≤19 entries) | 46 bytes plus the name per entry: 1-2 KB |

- Inflate would run when a scene loads or an interpreter is rebuilt, on the
  render task. That task is where memory is shortest during a switch storm
  (`docs/esp32-memory.md`).
- **Inflate time on the S3 is not measured.** For a 75 KB app source it
  should be milliseconds, but nobody has timed it. Against that, a deflated
  file is a third of the SPIFFS read.

**Writing on the device**

- A zip updated by appending a new entry and a new central directory breaks
  the store's rule: never write a slot in place, switch the index instead.
  It also grows the file without bound.
- A changed package is a new slot file with the unchanged entries copied
  through, which is exactly today's model. A per-entry change still writes
  the whole scene's file. The saving is on the wire, not on flash.

**SPIFFS has no directories**

- Entries as files would need names (32 characters), slots, and a lookup by
  name for each. The README measures about 0.5 s a lookup on a 24 MB
  `/state`, and a first creation at about 1 s.
- **The package stays one slot file**, as the scene is today.

**Contracts and both planes' patch logic**

- These all hash or split whole scenes as JSON and would each learn a file
  form:
  - `scene_hashes` and the set checksum (cloud: `JSON.stringify`; backend:
    canonical sha256);
  - `scenes_patch` / `?patch=1` `put`;
  - `nextScenesPart`'s part checksums;
  - `fos_scenes.c`'s `apply_backend_patch`;
  - the firmware's `base_checksum`.
- `frame_commands.payload` is jsonb. A zip in it would be base64, a third
  larger than the bytes, so a file patch is better kept as JSON with the
  files as strings.
- The AI patch fixtures, the MCP tool arguments and the iOS app need not
  change if the scene stays a JSON object in every API.

**Migration and backward compatibility**

- Every runtime and firmware in the field reads JSON:
  - `scenes.json(.gz)`;
  - an `uploadScenes` list;
  - a JSON slot file;
  - a JSON `set_scenes` / `scenes_patch`.
- Both planes already decide what to send by the runtime's version
  (`scenes_for_runtime`, `esp32SceneStoreSlotsFor`). Packages would be one
  more such gate, with JSON for anything older.
- The cloud's store zips are immutable, so readers keep reading the
  three-entry form forever.
- An old backend importing a new store zip reads only `scenes.json`. The
  store's download route already rebuilds zips (`rebuildZipWithSceneOrigins`)
  and can serve the old form to an old reader.

**Tooling**

- A zip in git is opaque. The repo must never hold zips, only the unpacked
  layout.
- Code that today does `json.load(scenes.json)` on a sample would read
  through a loader:
  - `api/repositories.py`;
  - `cloud/apps/auth-web/scripts/import-store-scenes.mjs`;
  - `cloud/apps/auth-web/scripts/build-playground-scenes.mjs`;
  - the e2e harness;
  - the scene tests: `test_scene_reader.nim`, `test_windowed_desktops.nim`.

## Alternatives

1. **Per-file layout, with zip only as the transport and package container.**
   - Directories where there are directories:
     - the repo, `repo/scenes/samples/<Name>/scene.json` +
       `apps/<app>/<file>`;
     - a Pi, `scenes/<id>/…` beside or instead of `scenes.json.gz`.
   - Zip where one blob is wanted: store versions, template downloads,
     backups, and later an ESP32 slot file.
   - This is the recommendation. Its cost is the loader and the pinned
     mapping, not a new storage engine.
2. **The ESP32's one file per scene, extended with sidecars**
   (`scene-<slot>.json` plus `scene-<slot>-a.bin`).
   - It doubles the slots, the lookups and the index fields, and makes a
     scene's change two commits.
   - The store's design argues against more files.
3. **A custom container.** For example, length-prefixed entries after a JSON
   header, or FOSB-like.
   - It reads and writes as easily as zip on the device.
   - But fflate (cloud, SPA), Python's `zipfile` (backend), `zip_entry.nim`
     (runtime) and every desktop tool already read zip. A custom format
     would need a reader on each, and a person could not open it.
   - Rejected.
4. **Stored (uncompressed) zip at rest, deflate only on the wire.**
   - Random access with no inflate RAM.
   - Flash use is no better than today (3,582 KB against 3,722 KB).
   - A middle form is worth keeping in mind: `scene.json` stored, apps
     deflated, 1,534 KB. `fos_scene_meta.c` could read that `scene.json` as
     today's JSON right after its 30-byte local header.
5. **Compression without packages.**
   - Deflated JSON per ESP32 slot file and `Accept-Encoding` on the
     backend pull, read through ROM `tinfl`: the set goes 3,531 → 1,073 KB
     on the wire and ~1.2 MB on flash.
   - It buys nothing structural: the whole scene is still inflated and parsed
     at load.
   - It is cheap, independent, and the biggest single number in this
     document. It is a valid first step whatever is decided about packages.

## Recommendation and phases

Keep the scene object as the model on both planes, in every API, the MCP
tools, the iOS app and the editor. Add a package layout as its file form,
and move each place that benefits onto it, one at a time.

1. **The mapping, pinned.**
   - `scene.json` holds the scene without `apps` and without code nodes'
     `codeJS`, keeping the keys in their order.
   - `apps/<keyword>/<file>` holds each source as it is, plus the app's
     config keys where `config.json` does not carry them.
   - `code/<node id>.js` holds a code node's code.
   - `assets/<path>` is reserved.
   - Ports: TypeScript (shared SPA), Python (backend) and Nim (runtime),
     pinned by a fixture corpus `docs/scene-package-fixtures.json` in the
     usual way.
   - The editor's file tree, the Code editor's `filesOf` and the AI tools'
     paths move onto it, which aligns `<app>/<file>` with `apps/<kw>/<file>`.
   - No behaviour change. It unlocks everything below.
2. **The repo's samples unpacked.**
   - `repo/scenes/samples/<Name>/{template.json, image.jpg, scene.json,
     apps/…}`, with `scenes.json` generated from them. It is either checked
     in under a `--check` like the other generators, or built by the readers'
     loader.
   - It makes git diffs real (86 lines over 10 KB today) and lets
     `repo/apps` templates and the desktops' shared code be compared per
     file.
   - Developer-facing only. Frames are unaffected.
3. **Compression on the wire to an ESP32 (independent of packages).**
   - `Accept-Encoding: gzip` on the backend pull, inflated by ROM `tinfl` as
     FOSB v2 is. For the hub, a binary deflated frame for `set_scenes` /
     `scenes_patch` on new firmware.
   - Roughly 3.3 times fewer bytes, so a 512 KiB message holds about three
     times as much of a set and fewer sets need parts.
4. **Patches by file.**
   - `scenes_patch` and `?patch=1` gain `files: {"<id>": {"<path>": text |
     null}}` beside `put`, hashed per entry, for runtimes that declare it.
   - About 44% fewer bytes in the history replay, and far fewer for graph
     edits.
   - Both planes and `fos_scenes.c` change together, with a fixture corpus
     for the patch.
5. **Store and template zips carry the layout.**
   - A version's zip holds `template.json` (with a format number), the
     cover, and per scene its files under `scenes/<id>/`.
   - Readers on both planes accept both forms. A download for an old reader
     is rebuilt as the three-entry form.
   - It lets a version be read and diffed by file, and it is where assets
     first appear.
6. **Packages at rest on the devices.**
   - **A Pi:** a directory per scene (or a zip per scene for the uploaded
     set, replacing `state/uploaded.json`). It parses `scene.json` at load
     and reads app sources when an interpreter starts: about 3.3 MB less
     resident for the sample set. An upload read without the std/json round trip
     also loses the 31 MB peak (that fix needs no package).
   - **An ESP32:** the slot file becomes the scene's zip, `scene.json`
     stored first, apps deflated. That is about 2.4 times less `/state` than
     today; deflating `scene.json` too gives about 3 times less. Inflate
     runs through ROM `tinfl`.
   - Measure the flash and the load time on the bench before deciding (the
     3-8 KB above is an estimate).
7. **Assets in scenes.**
   - `assets/<path>` entries, read in place by `zip_entry`.
   - A scene-relative name in the JS API, for example
     `readAsset('scene:countries.json', {entry})` or a `scene` storage beside
     `assets` / `internal`.
   - A cap per board, because an asset on an 8 MB board's 1 MB `/state`
     competes with scenes. A large asset may belong on the card, with the
     package naming it.
   - Visited World Map's outlines are the first candidate.

Phases 1-3 are each a small pull request and are useful alone. Phase 4 is
the first one that touches both planes' wire contracts. Phases 6 and 7 are
where "a scene is a zip" becomes true on a frame.

## Open questions for the owner

1. **What is the first goal: assets in scenes, smaller transfers, or editing
   by file?** It decides whether phase 5/7 or phase 3/4 goes first.
2. **Repo samples as directories:** should `scenes.json` be generated and
   checked in (its bytes twice in the repo, guarded by `--check`), or built
   when read?
3. **Shared files across scenes** (14.5% of the set's bytes): should a scene
   stay self-contained, as an installed copy is today, or may packages share
   a file by content hash on the device and in the store?
4. **Where does a scene's asset live on an 8 MB ESP32:** inside the package on
   `/state`, or on the card with the package naming it? And what cap does a
   package get?
5. **Old readers of store zips:** should the store rebuild the three-entry
   form forever for old backends, or should backends below a version be told
   to update before importing?
6. **Should a frame accept a package directly** (`scene-put` of a zip over
   USB and HTTP, an install from the store's zip instead of its scenes.json),
   or is JSON enough at the device's door?
7. **Compression on the wire to an ESP32 first?** It needs no packages and is
   the largest single number here (3.5 MB → 1.1 MB for the sample set).
