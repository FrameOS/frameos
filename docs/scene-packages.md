# Scene packages: a scene as files

A scene is still a JSON object in every API, every editor, the MCP tools and
the iOS app. A **scene package** is that object laid out as files. It is the
shape a scene has inside a template zip. It is also a file a frame can keep:
a Pi's deployed set, an ESP32's slot, or a package handed to the browser
preview. **A loaded scene keeps none of its apps' files**, whichever form it
was read from. An app reads them when its interpreter starts, compiles them
and lets them go.

This page is the contract. `docs/scene-package-fixtures.json` pins it, and
three ports replay that corpus:

- `frontend/src/utils/scenePackage.ts`, used by the SPA and the cloud;
- `backend/app/utils/scene_package.py`;
- the runtime's reader, `frameos/src/frameos/scene_package.nim`, which only
  reads.

The investigation that led here, with its measurements, is at the end
("Background").

## The layout

One scene:

```
scene.json             the scene, every app's `sources` taken out
apps/<keyword>/<file>  each file of apps[keyword].sources, its text as it is
assets/...             reserved: no reader takes it yet
```

**`scene.json`**

- It is the scene object with only `apps[*].sources` removed. Every other key
  stays: the apps' own keys (`name`, `category`, `origin`, ...), the graph,
  the settings, and the inline code. Inline code means code nodes' `codeJS`
  and an app node's own `data.sources`.
- Writers print it with two-space indentation. Readers compare it as JSON,
  never byte for byte.

**`apps/<keyword>/`**

- The folder name is the app's keyword with `%` written as `%25` and `/` as
  `%2F`.
- A file path inside the folder may have folders of its own
  (`lib/util.ts`).
- A path that is absolute, holds a backslash, or has an empty, `.` or `..`
  segment is refused by the planes' readers (`unsafe_path`). The runtime uses
  the names only as keys, opens nothing by them, and so does not check them.

**Reading a package back**

- Each file goes back into `apps[keyword].sources`, after whatever
  `scene.json` still carries; a file wins over a source with the same name.
- An app folder that `scene.json` does not name becomes that app. The
  runtime looks only for the apps `scene.json` names, and every writer names
  them.

A set (a template, a Pi's deployed set) is a folder of scene folders, the way
the scene editor's file tree shows a template:

```
template.json          the listing; `scenes`: ["./<folder>", ...], their order
image.jpg              a template's cover
<folder>/scene.json, <folder>/apps/<keyword>/<file>
```

**Scene folders** are named after the scene (`sceneFolderNames`):

- Characters a file system refuses become `-`. Runs of space become one, and
  the name is trimmed and cut at 64 characters.
- An empty name falls back to the id.
- When a name is taken (compared without case), reserved (`apps`, `assets`)
  or ends in a file's extension, it gets the id beside it.

**Where a set starts** (`packageRoot`):

- The folder of the shallowest `template.json`. A template zip keeps
  everything under `<name>/`.
- Without one, the parent of the shallowest scene folder.
- Without that, the folder of a `scenes.json`.

**Scene order.** Folders that `template.json` does not list come after the
listed ones, sorted by name.

**The form before packages is read everywhere.** That form is a
`template.json` naming `"./scenes.json"` beside a `scenes.json` that holds the
whole array, app sources included. A bare `scenes.json`, or one scene package
at the top of a zip, reads too.

**Refusal codes** (the fixtures' `refusals`):

| Code | When |
| --- | --- |
| `missing_scenes` | no scene anywhere |
| `missing_scene` | `template.json` lists a folder that has no `scene.json` |
| `invalid_scene` | `scene.json` is not one JSON object |
| `invalid_template` | `template.json` is not a JSON object, or lists something that is not a folder name |
| `invalid_scenes` | a legacy `scenes.json` is not a list of scenes |
| `unsafe_path` | as described under "The layout" |

**A frame's package** (one scene in a ZIP: an ESP32 slot, a package put over
USB or HTTP):

- `scene.json` is its first member, stored (not deflated), with its sizes in
  the local header.
- The board reads what its index keeps straight after the 30-byte header and
  the name (`main/fos_scene_package.c`).
- App files may be deflated.
- The planes write it this way: `scene_package.device_package_bytes`.

**App tests never reach a frame.** `*.test.ts`, `.tsx`, `.js` and `.jsx` run
in the editor. Both planes strip them from everything they send to any frame:

- backend: `retired_apps.scenes_for_frame`;
- cloud: `retired-apps.ts` `scenesForFrame`.

Until now this was done for an ESP32 alone. When a frame's code editor saves a
scene back, the plane puts the tests of its own copy back
(`keep_app_test_files` / `keepAppTestFiles`, in `panel_code.py` and
`panel-code.ts`).

## What a loaded scene keeps

**The scene reader** (`interpreter.nim`, "Reading scenes.json")

- It takes a `SceneFiles` saying where the scene's apps' files can be read
  again:
  - `sfJson`: a scenes.json(.gz) or `state/uploaded.json` on disk;
  - `sfPackage`: a ZIP or a folder, with the scene's folder in it;
  - `sfHost`: the host's own file of the scene, by id, through
    `sceneFileReader` (an ESP32's slot, from the slot cache when it is
    there);
  - `sfResident`: nowhere.
- For every kind but `sfResident` it passes over each app's `sources`
  (`readAppsWithoutFiles`), so the parsed scene never builds them.

**Reading an app's files**

- The interpreter reads them when the app node is made and when its
  interpreter starts again (`appSourcesFor`, `appSourcesFromFiles`).
- From JSON, `appSourcesInJson` reads that one app's `sources` and builds
  nothing else.
- From a package, it reads that one app folder's members.

**After compiling** (`app_runtime.ensureReady`)

- The app drops `source` and `sources`. QuickJS strips the source itself
  (`JS_STRIP_SOURCE`).
- A teardown (after a render on a deep sleeper, when memory runs short, a
  scene switch) reads the files again the next time the interpreter starts
  (`JsAppRuntime.reload`).
- A module imported after the compile reads them again too (`haveSources`).

What a scene keeps on the Nim heap: `frameos/tools/scene_memory_probe.nim`,
the repo samples read the way a board reads its slot (x86_64; an ESP32's
32-bit pointers make the trees smaller, and the sources are the same bytes):

| Sample | JSON | Parsed, before | Parsed, now | Held after a render, main | Held after a render, now |
| --- | ---: | ---: | ---: | ---: | ---: |
| Brick breaker | 76 KB | 96 KB | 16 KB | 120 KB | 37 KB |
| Code editor | 70 KB | 81 KB | 12 KB | 125 KB | 31 KB |
| Star shooter | 88 KB | 111 KB | 18 KB | 114 KB | 39 KB |
| Snake | 74 KB | 92 KB | 17 KB | 111 KB | 38 KB |
| Windows 98 layout | 68 KB | 79 KB | 14 KB | 137 KB | 44 KB |

**Reading the table**

- "Held after a render, main" is origin/main with the same probe. It also
  keeps the main module's source as a second copy in each app's runtime,
  which is gone too.
- The cost is a read of the scene's file each time an interpreter starts.
  On an ESP32 that is a copy out of the slot cache, or a SPIFFS read.
- On a Pi, the deployed `scenes.json.gz` is inflated once per scene
  instance (`sceneFilesText`, while `init` runs), and once per interpreter
  that starts again later.

The board numbers are in the pull request that built this.

## Each host

**A Pi**

- It reads `./scenes.zip`, the deployed set as a package, before
  `scenes.json.gz`. Each scene's `scene.json` is parsed, and its apps' files
  stay in the ZIP.
- An uploaded set (a preview, the cloud's `set_scenes`) is written to
  `state/uploaded.json` before its scenes are registered. The scenes read
  their apps' files from there, and the payload is no longer held in memory
  as well (`getUploadedScenePayload` reads the file).
- The readers of whole scenes assemble a package's scenes with
  `scenesOfPackage`: the frame API's `loadScenePayload`, the Code editor's
  host, `frameos setup`'s apt packages, the index scene's list.
- `upgrade` carries `scenes.zip` over.
- Scenes changed on the frame itself (`persistScenesPayload`) become a
  `scenes.json.gz` again, and the package goes.

**An ESP32**

- A slot file is the scene's JSON, as before, or a package as it came. The
  store reads a package's `scene.json` where it lies to make the index entry
  (`fos_scene_store.c`). It refuses a package whose `scene.json` is not
  first and stored.
- `frameos_nim_load_scene` now takes a length, since a package's bytes are
  no C string.
- The runtime reads `scene.json` out of the slot's bytes (`storedSceneJson`,
  through `utils/zip_entry.nim`, which reads a ZIP in memory as well as in a
  file). It reads an app's members when its interpreter starts
  (`fos_scenes_read_scene_file`, the slot cache's copy when it has one).
- A reader of a scene's JSON gets a package's scene whole again
  (`fos_scene_package_to_json`: cJSON and the ROM's inflater): the Code
  editor, `GET .../scenes/<id>`, `scene-get`, the cloud's `scenes_get`.
- Both planes still send JSON. See "Not built yet".

**The browser preview**

- `frameos_wasm_load_scene_package(bytes)` loads a package or a template zip
  in place of the scenes' JSON (`FrameOSPreview`'s `scenePackage`).
- The page holds the scenes anyway, so the preview keeps their files
  (`sfResident`).

## Each plane

**Template zips are scene packages on both planes.**

- **Backend:** `templates.py` `template_zip_bytes` writes them;
  `template_zip_scenes` reads either form for upload, URL import and
  `format=zip|scenes`.
- **Cloud store:** every new version is one (`scene-zip.ts`, through
  `buildSceneZip`, `rebuildZip` and `rebuildZipWithSceneOrigins`).
- **Cloud readers:** `validateSceneZip`, `extractScenesJson`, the
  scenes.json route and the others read either form through
  `readTemplateZip`.
- **Browser:** the upload drawer's `sceneUpload.ts` reads both.
- **Old versions** stay as they are: versions are immutable, and every reader
  takes the old form.

**A self-hosted backend from before packages** reads only `scenes.json`.

- The store page's `frameos:zip` tag, which is what such a backend fetches
  when a store URL is pasted, names `.../download?layout=json`: the same
  scenes in the old form.
- The download button gets the packages.

**A backend's Pi deploy**

- A runtime from `SCENE_PACKAGES_RUNTIME` (2026.11.14) on is sent
  `scenes.zip` (`FrameDeployer.upload_scenes`). An older one is sent
  `scenes.json.gz`, as before.
- Whichever is not sent is removed from the release.
- A fast deploy keeps the runtime the frame runs, so it decides by that
  runtime's version.

**What does not change**

- The scene stays a JSON object at every API: the SPA, the MCP tools (a zip
  URL goes through the template routes), the iOS app (opaque `JSONValue`)
  and the AI tools' `apps.<kw>.sources.<file>`.
- The Code editor scene lays a scene out as `apps/<app>/<file>` like a
  package. It also shows code nodes as `code/<node>.js`, a view: a package
  keeps them in `scene.json`.

## The ESP32 image

Measured on local builds of the generic S3 image, against origin/main at the
base of this stack (the pull request's firmware-size comment has CI's figure
against the latest release):

| Build | App image |
| --- | ---: |
| origin/main (d53ec4e1e) | 3,192,000 B |
| first version of this change | 3,205,712 B (+13,712) |
| as merged | 3,199,440 B (+7,440, 0.23%) |

**What slimming did**

- The board needs no set reader. A slot is one package and its `scene.json`
  is a member that `zip_entry` already finds, so `packagedScenes`, the
  `template.json` handling and the path checks are not compiled into the
  firmware.
- An app's files are matched by its own folder name, not by decoding every
  member's.
- The JSON scanner leaves out the upload's list, which is a Pi's.
- `hasJsAppSource` no longer copies a main module to see that it is there.

**What is left** (symbol sizes on the S3)

| Part | Size |
| --- | ---: |
| `fos_scene_package_to_json` (a package's scene whole again for its JSON readers) | 1,078 B |
| The store's check | about 165 B |
| `appSourcesInObject` + `appSourcesInJson` (one app's files out of a JSON slot) | about 780 B |
| `appSourcesOf` (one app's files out of a package) | about 600 B |
| `readAppsWithoutFiles` | about 350 B |
| `appSourcesFromFiles` / `appSourcesFromSceneFiles` / `appSourcesFor` | about 670 B |
| The reload and drop in `ensureReady` | about 200 B |
| `zip_entry` reading from memory | about 250 B |
| The rest | small pieces |

**Where to cut, and what each costs**

| Cut | Saves | Loses |
| --- | ---: | --- |
| Hand a package's readers the package itself | about 1.1 KB | The Code editor, `scene-get` and the cloud's `scenes_get` cannot read a package slot |
| No package slots at all, JSON only | about 2.5 KB | The board reads no package |

The memory saving (the sources out of the parsed scene and out of each app's
runtime) needs neither; it comes from reading JSON slots lazily. The old JSON
path stays: a board keeps every scene it holds today as it is, and dropping
JSON slots would save nothing that this change adds.

## Not built yet

**Packages on the wire to an ESP32.**

- Both planes send an ESP32 its scenes as JSON:
  - the backend's `/embedded/scenes?patch=1`;
  - the hub's `set_scenes` and `scenes_patch`, which are JSON text frames.
- The board keeps each scene as JSON, and the runtime reads an app's files
  out of it when it needs them, so the memory saving is had without a
  package.
- A package in those messages would be base64 inside JSON.
- **Deflated packages** would be about 44% of the JSON (deflate's 3.3 times,
  less a third for base64). The firmware would need a base64 decode in the
  pieces reader and the staging path.
- **Per-file patches** (`files: {id: {path: text|null}}` beside `put`) are
  the other half of the same change.

**The repo's samples as folders.**

- `repo/scenes/samples/<Name>/` still holds a `scenes.json`.
- Unpacking them makes git diffs real: 86 lines are over 10 KB today, the
  longest 80 KB.
- About sixty readers would need a loader each: the Nim tests, the
  firmware's host tests, the playground and AI-context builders, the e2e
  harness, the iOS layout starters and the backend's repositories.

**Assets in a package.**

- `assets/<path>` is reserved.
- `readAsset(path, {entry})` already reads a member in place, so a
  scene-relative name is the step after.
- What Visited World Map's 63 KB of outlines written as TypeScript wants.

## Background: the investigation (2026-11-20)

The numbers come from `frameos/tools/measure_scene_packages.py` (sizes, SPIFFS
footprints, a replay of the samples' git history) and
`frameos/tools/scene_parse_probe.nim` (the heap a Linux runtime spends reading
a set). Both are quoted with the command that produced them.

**The 116 repo scenes**

| | Size |
| --- | ---: |
| Compact JSON | 3,585 KB |
| ... of which JS app source | 87.6% |
| ... of which the graph | 12.3% |
| ... of which code nodes | 0.1% |
| JSON escaping of the sources, on top | 199 KB |
| One scene, median | 24.8 KB |
| One scene, largest (Calendar) | 93 KB |

- Before this change, every container held the scene as one JSON entry: the
  template zip, the store's zips, `scenes.json.gz` and the ESP32's slot
  files.
- No frame was ever sent a zip.
- Nothing reached an ESP32 compressed.

**Compression**

| Form of the whole set | Size |
| --- | ---: |
| Compact JSON | 3,585 KB |
| Each scene's JSON deflated | 1,073 KB |
| A ZIP per scene, every entry deflated | 1,172 KB |

- That is 3.3 times less than the 3,531 KB an ESP32 is sent.
- Small entries compress worse, so deflating each scene's JSON whole beats
  the per-entry ZIP.

**On SPIFFS (256 B pages)**

| Slot file per scene | Space used |
| --- | ---: |
| JSON | 3,722 KB |
| Package, `scene.json` stored, apps deflated | 1,534 KB |
| Package, all deflated | 1,240 KB |

Splitting each entry into its own file is not viable: 514 files against 256
slots, and a SPIFFS lookup by name for each.

**Per-file patches.** The last 89 commits to the samples made 612 scene
changes, 58% of them to the graph alone. Per-scene patches would send
17.0 MB; per-file patches would send 9.6 MB, about 44% less.

**A Pi reading the whole set**

- The deployed path peaks at 12.5 MB of heap.
- App sources were about 3.3 MB of what stayed resident. This change removes
  that.
- The upload path peaked at 30.9 MB for a 3.6 MB body. That comes from its
  std/json round trip, not the format.

**Duplicate files.** Keeping files once by content hash would save 14.5%
across the set: the games' shared helpers, the iCal app in four scenes. The
packages do not share files; each installed scene stays a copy.
