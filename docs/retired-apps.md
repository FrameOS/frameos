# Retired built-in apps

A built-in Nim app that gets a repo JavaScript replacement is deleted from the
runtime in the same change, without anyone redeploying, re-editing a scene or
noticing. `docs/retired-apps.json` lists them:

| retired keyword | replacement | first runtime | why that runtime |
|---|---|---|---|
| `data/immich` | `repo/apps/code/immich` | 2026.10.11 | `frameos.fetchImage` |
| `data/frameOSGallery` | `repo/apps/code/frameOSGallery` | 2026.10.11 | `frameos.fetchImage` |
| `data/unsplash` | `repo/apps/code/unsplash` | 2026.10.11 | `frameos.fetchImage` |
| `data/wikicommons` | `repo/apps/code/wikicommons` | 2026.10.13 | `app.frame.embedded` (the ESP32's 900 px thumbnails) |
| `data/googlePhotos` | `repo/apps/code/googlePhotos` | 2026.10.13 | `frameos.remember` (the album list outlives an ESP32 render) |
| `data/openaiImage` | `repo/apps/code/openaiImage` | 2026.10.13 | `app.frame.embedded`, and saving a `data:` URL (the `b64_json` reply) |
| `data/openaiText` | `repo/apps/code/openaiText` | 2026.10.11 | `frameos.httpRequest` |
| `data/haSensor` | `repo/apps/code/haSensor` | 2026.10.11 | `frameos.httpRequest` |
| `data/weather` | `repo/apps/code/weather` | 2026.10.11 | `frameos.httpRequest` |
| `data/beRecycle` | `repo/apps/code/beRecycle` | 2026.10.13 | a throw in `get()` fails the node |

The replacement runs only on a runtime that has what it `needs`. Firmware
older than `runtime` still has the Nim app, so it is sent the Nim keyword.
Stored scenes only ever hold the JavaScript app.

## The cut

Three moves, one per direction a frame and its control plane can disagree in.

**Everything stored becomes the JavaScript app.** A node naming a retired
keyword becomes a node of the scene-local app the replacement turns into: the
app's `config.json` keys plus `origin` and `sources` under `scene.apps`. The
key is `sceneAppKey`, or an existing entry with the same `origin`. The node's
config, cache and edges are untouched, since the fields keep their names.
A node that carries its own `data.sources` is an edited copy and is left alone.

- **Backend:** an alembic migration (frames, their deploy baseline,
  templates), then every door scenes come in by: template import, backup
  restore, scene pulls from a device, and the frame form's save
  (`backend/app/utils/retired_apps.py`).
- **Cloud:** store versions are immutable zips, so nothing is rewritten. Every
  reader converts instead, next to the `origin` stamp: the workspace's
  `scenes.json`, the server render, lint, the converter and the AI tools
  (`cloud/apps/auth-web/src/lib/retired-apps.ts`). The zip download that
  self-hosted backends install from stays raw, because an older backend still
  needs the Nim keyword and a current one converts on import.

**What a device is sent depends on its runtime.** One function per plane,
`scenes_for_runtime` / `scenesForRuntime`, sits on every path to a device:

- A runtime older than `runtime` gets the retired keyword back, and the app
  entry is dropped.
- Every other runtime, and an unknown one, gets the JavaScript app. Unknown
  means a fresh install of the current release, the same rule as the command
  queue's firmware floor.

Where each path learns the runtime:

| path | runtime |
|---|---|
| backend Pi full deploy, SD image, bootstrap | the release the backend installs |
| backend Pi fast deploy, preview upload, frame sync push | the frame's last reported version |
| backend ESP32 pull (`/embedded/scenes`: the saved scenes or a queued preview, the commands ETag) | the version in the board's last bootup line |
| cloud `set_scenes` (assignments, preview pushes) | `frames.frameos_version` from the hello |

A development build reports the version of the release before it, so it is
judged as that release.

**A frame that moves to a newer runtime moves its scenes too.**

- **ESP32 on a backend:** it pulls on every wake. A boot posts its bootup line
  before the first pull, so the pull right after an OTA already gets the new
  form, under a new ETag.
- **Cloud frames:** the hub rebuilds the assigned set when a hello reports a
  new firmware version. If the checksum moved, it pushes the same assignments
  again, keeping the active scene.
- **Linux runtime:** a Pi updates itself (`auto_update`, the admin UI) and
  carries `scenes.json` forward without a redeploy. A scene deployed under the
  old release therefore still names the retired keyword. The Linux runtime
  runs the replacement for such a node from a generated copy
  (`frameos/src/frameos/retired_apps.nim`). The ESP32 and the wasm preview do
  not carry that copy.

## Adding an entry

1. Ship the replacement as `repo/apps/code/<app>` and make it a faithful port.
   Same field names, so a converted node keeps its config.
2. Add the keyword to `docs/retired-apps.json` and to `RETIRED_APPS` in
   `backend/app/utils/retired_apps.py`.
3. Set `runtime` to the first release with what the replacement needs. For
   unreleased work, that is the next patch after the `versions.json` base.
4. Run `python3 frameos/tools/generate_retired_apps.py`. It writes the cloud's
   table (`retired-apps.gen.ts`) and the Linux fallback
   (`retired_apps_gen.nim`).
5. Add a backend alembic migration that calls `retire_apps_in_scenes`.
6. Delete the Nim app and regenerate the registries and catalogs (`make
   apploaders`, `generate_apps_asset_nim.py`, `generateBuiltinApps.mjs`).

A change to a replacement's files needs the generator run again, since the
cloud and the Linux fallback carry a copy. `test_retired_apps.py` fails until
it is.

`docs/retired-apps-fixtures.json` pins both implementations
(`backend/app/utils/tests/test_retired_apps.py`,
`cloud/apps/auth-web/src/lib/retired-apps.test.ts`).
