# The iOS app

`ios/` is a native app (SwiftUI, iOS 17 and up) for both control planes. It
signs in to **FrameOS Cloud** by default and, below that, to a **self-hosted
backend**, and keeps several accounts side by side. It does on a phone what
the workspace does, without the diagram editor: no node graphs, no code, no
app editing. Building and running it is in `ios/README.md`.

The app is a third client of the same HTTP API, next to the shared SPA
(`frontend/src`) on the backend and on the cloud. The rule that keeps it in
step is the repo's rule for every other copy: **one source, many readers.**
The app calls the routes the SPA calls, reads the tables the SPA reads, and
the logic the SPA decides in shared code is either generated for Swift or
pinned to the SPA by a corpus both replay. A change that one side does not
follow turns a test red, on the side that did not follow.

## How the app stays in step

| What | Source of truth | How the app reads it | Pinned by |
| --- | --- | --- | --- |
| Which paths a backend scopes to a project | `isProjectScopedApiPath` (`frontend/src/utils/projectApi.ts`) | `ApiPaths.isProjectScoped` (`ios/FrameOSKit/.../Core/APIClient.swift`) | `docs/api-path-fixtures.json` |
| The deploy bar (stages, labels, stale rules) | `docs/deploy-progress-contract.json` | generated `DeployProgressContract.gen.swift`, read by `Contracts/DeployProgress.swift` (the SPA's `frameDeployProgress`) | `generate_deploy_progress_contract.py --check` (backend suite); the `stale` and `percent` sections of `docs/deploy-progress-fixtures.json`; `docs/frame-status-fixtures.json` |
| A frame's status word, the line under its name, the firmware word | `frontend/src/decorators/frame.tsx` | `Contracts/FrameStatus.swift`, `FrameTime.swift` | `docs/frame-status-fixtures.json` |
| The frames list's order: Active, Inactive, Archived, each by name (also the frame pickers) | `groupFramesByStatus` (`scenes/workspace/frameStatusGroups.ts`), `frameIsActive` | `Contracts/FrameGroups.swift`, `FrameStatus.isActive` | the `groups` section and `expect.active` of `docs/frame-status-fixtures.json` |
| The store's shelves and their order | `frontend/src/utils/storeCategories.ts` (checked against the cloud's `categories.ts`) | `Contracts/StoreCategories.swift` | `StoreCategoryTests` reads the SPA's file |
| Which settings a cloud frame takes | `docs/cloud-frames-contract.json` | generated `CloudFramesContract.gen.swift`, read by `Contracts/CloudSettingsContract.swift` (the SPA's `cloudFrameSettings.ts`) | `generate_cloud_contract.py --check` |
| A scene's settings form (the implicit refresh interval, `showIf`) | `frontend/src/utils/refreshInterval.ts`, `showIf.ts` | `Contracts/SceneFields.swift` | `docs/scene-form-fixtures.json` |
| "Button actions" rows and the rules they write | `frontend/src/utils/frameEventMap.ts` | `Contracts/ButtonBindings.swift` | `docs/button-map-fixtures.json` |
| A typed backend address | `docs/server-address-fixtures.json` | `Contracts/ServerAddress.swift` | the same corpus (its fourth runner) |
| The words for queued commands | `commandLabels` in `framePendingCommandsLogic.ts` | `PendingCommand.labels` | `PendingCommandLabelTests` reads the SPA's file |
| Installing scenes and albums on a backend (fresh ids, references rewritten) | the backend's `duplicate_scenes` and its MCP tools | `frame_scene_install`, `photo_album_install` over `POST /api/mcp` | the backend's own tests: the app adds no copy |

The SPA runs the corpora in `cloud/apps/auth-web/src/test/shared-spa/`
(`*-fixtures.test.ts`), the app in `ios/FrameOSKit/Tests/` (both read the
files in `docs/` directly). The **iOS app** workflow
(`.github/workflows/ios.yml`) runs the app's side whenever a corpus, a
contract, the SPA's command labels or `ios/` changes, builds the app for
the simulator and runs its UI tests there (the sign-in screen).

Against real planes (skipped unless an address is given, `ios/README.md`):

- `BackendIntegrationTests` walks the backend path end to end (sign-up or
  sign-in, the token, a frame, an install through the MCP, settings, photos,
  the socket, sign-out); `ios/bin/test-backend` starts a throwaway backend
  with a user and two virtual frames for it.
- `CloudIntegrationTests` does the same signed in to a cloud you may write
  to (a local dev server): a store scene installed, activated and removed
  on a frame, settings, schedule, photos, the live socket, sign-out.
  `CloudProbeTests` checks a cloud read-only (the sign-in's Origin and error
  shapes, the public store).
- The UI tests' tour (`TourUITests`, `ios/bin/ui-test`) taps through the
  whole app on a simulator against either plane and keeps a screenshot of
  every screen.

## Every action and its route

`B` is the self-hosted backend (paths written canonical, sent as
`/api/projects/{p}/...`), `C` FrameOS Cloud. Where the planes differ the app
branches in one place (`ios/FrameOSKit/Sources/FrameOSKit/Services/`), the
way the SPA does, and the comment there names the SPA file.

| Action | B | C |
| --- | --- | --- |
| Sign in | `POST /api/login` (form), then a year-long API token (`POST /api/user/api_tokens`, revoked at sign-out) | `POST /api/auth/login`, `POST /api/auth/second-factor/code`; the session cookie; `Origin` on every write |
| Google, passkeys (the web's sign-in) | (none: a backend signs in with its own password) | the system sign-in sheet on `GET /api/auth/app/authorize` (PKCE), then `POST /api/auth/app/token {code, code_verifier}`: a session of the app's own (`cloud/docs/auth.md` "Signing in to the app") |
| Sign in with Apple | (none: cloud only, like Google) | the system's Apple sheet, then `POST /api/auth/apple/native {identity_token, authorization_code, nonce}`; `409 link_required` asks for the matched account's password (`POST /api/auth/link`) (`cloud/docs/auth.md` "Sign in with Apple") |
| Sign out | `DELETE /api/user/api_tokens/{id}`, `POST /api/logout` | `POST /api/auth/logout` |
| Frames | `GET /api/frames`, `GET /api/frames/{id}` | the same |
| Live updates | `/ws` (the `frameos_session` cookie from the login) | `/api/frames/updates` on the hub (the session cookie) |
| Picture | `GET /api/frames/{id}/image?t=-1` (cached) or `?t=<now>` (from the frame) | the same; PNG or, from an ESP32, BMP |
| Scene list | `frame.scenes` | `GET /api/frames/{id}/scenes`, then each row's `GET /api/store/scenes/{id}/scenes.json?version=` |
| Values of the scenes' fields | `GET /api/frames/{id}/states` | the same |
| Activate / Apply | `POST /api/frames/{id}/event/setCurrentScene {sceneId, state?}` | the same |
| Remove a scene | save `scenes` without it, then deploy | `POST /api/frames/{id}/scenes` without its row |
| Start on boot | `default` on that scene alone, saved, then deploy | (none: not offered for a cloud frame) |
| Update a scene | (on the web: the backend has no route for it) | `POST /api/frames/{id}/scenes/update` |
| Install a scene | MCP `frame_scene_install` (saved scene, catalog entry, or scenes; `settings_groups` grants a store scene the keys it declares) | `POST /api/frames/{id}/scenes/add` (`settings_groups` the same way) |
| Catalog | `GET /api/templates`, `GET /api/repositories` | `GET /api/store/browse`, `GET /api/account/scenes` |
| Preview row | `GET`/`DELETE /api/frames/{id}/scene_preview` | `GET`/`DELETE /api/frames/{id}/scene-preview` |
| Render, restart, reboot | `POST …/event/render`, `…/restart`, `…/reboot` | the same |
| Screen on / off | `POST …/event/turnOn`, `…/turnOff` | the same |
| Update FrameOS / firmware | `POST …/embedded/firmware/ota` (ESP32), `POST …/device/upgrade` (Linux) | `POST …/command {"type": "notify_update_available"}` |
| Deploy | `POST …/fast_deploy` or `…/deploy` | (none: the cloud pushes as it saves) |
| Waiting for the frame | `GET`/`DELETE …/commands` | the same |
| Logs, metrics | `GET …/logs`, `…/metrics`, `POST …/event/metrics` | the same |
| Settings | `POST /api/frames/{id} {key: value}` then deploy | `POST …/settings {settings}`, keys from the contract |
| Schedule | `schedule` in the same save | `POST …/schedule` |
| Button actions | `event_map` in the same save | the `event_map` setting |
| Voice chat switches | `device_config` (`voiceChangeSettings`, …) | `POST …/voice/permissions` |
| Rename, delete | `POST /api/frames/{id} {name}`, `DELETE /api/frames/{id}` | the same (delete asks for a recent sign-in: `reauth_required` → `POST /api/auth/reauth`, or the sheet with `reauth=1` for an account without a password or code) |
| Assets | `GET …/assets?folder=`, `GET …/asset?path=`, chunked `POST …/assets/upload`, form `POST …/assets/{mkdir,rename,delete}` | the same |
| Photos | `/api/photos/...` (`docs/photos.md`) | the same |
| Play an album | MCP `photo_album_install` | `POST /api/photos/scene`, `POST /api/account/scenes`, `POST …/scenes/add` |
| AI chat | `POST /api/ai/chat` (NDJSON, `editor: false`), `GET /api/ai/chats` | the same; a `proposal` is approved with `…/scenes/add` |
| API keys for scenes | `GET`/`POST /api/settings` | the same |
| Confirm a claimed frame | (none) | `POST /api/frames/{id}/confirm` |
| Scenes a frame brought with it | (none) | `GET`/`POST /api/frames/{id}/device-scenes` (`import` / `dismiss`) |
| Local network access | (none: a backend's frames have no block) | `POST …/lan_access/challenge`, then `POST …/lan_access {enabled, code}` |
| API keys and telemetry switches | (none) | `POST …/service-settings/enabled`, `POST …/telemetry/enabled` |

App Store submission, TestFlight and the guidelines: `docs/ios-app-store.md`.

## What the app leaves to the web

Deliberately, so a phone does not grow a second editor:

- the diagram editor, code nodes, app sources, scene publishing;
- adding a frame (flashing, the SD card builder, SSH setup, adoption) and
  hardware wiring (drivers, pins, GPIO buttons, the network);
- per-photo color profiles (the app shows that one is set; the editor's
  preview is the web's `utils/assetColors/`);
- a backend's terminal, deploy plan, SD images and build caches.

Settings → "Open the web workspace" goes there.

## Words

The app uses the verbs of `docs/ui-vocabulary.md`: a scene is **installed**
and **pushed**, settings and FrameOS are **deployed**, a show-for-now is a
**preview** that is **discarded**, a newer version is an **update**, and
**Activate** turns into **Apply** on the scene showing. "Upgrade" is never
shown.

## Adding to the app

1. Find the route the SPA calls (`apiFetch` in the SPA file) and call the
   same one from a service in `ios/FrameOSKit/Sources/FrameOSKit/Services/`.
   A new plane difference is a branch there, with the SPA file named.
2. If the SPA decides something in shared code (a word, a rule, a
   threshold), do not copy it into Swift by hand: generate it from its
   contract, or add a corpus in `docs/` with a runner on both sides (the
   existing `*-fixtures.test.ts` and `*FixtureTests.swift` are the
   templates), or read the SPA's file in a test.
3. Screens live in `ios/FrameOSUI`, their state in an `@Observable` model
   next to them (the kea logic's place), the view a template.
4. `ios/bin/test` and `ios/bin/check-ui` run without Xcode; the **iOS app**
   workflow builds the app.
