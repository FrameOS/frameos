# @frameos/cloud-frontend

The FrameOS Cloud wrapper bundle — the third thin SPA wrapper around the
shared frontend (`frontend/src`), sibling of the on-device wrapper
`frameos/frontend/`. It deep-imports the workspace shell (FramesHome, the
frame workspace, the scene/apps workspaces, socketLogic, the kea models),
sets `window.FRAMEOS_APP_CONFIG.cloudMode = true`, and esbuilds a static
bundle that Next.js (`cloud/apps/auth-web`) serves at
`account.frameos.net/frames/**`. Design: `cloud/docs/cloud-frames.md`
("Frontend: the fourth adapter"); wire contract: `docs/cloud-frames.md`.

## Build

```bash
pnpm --dir cloud-frontend build   # -> dist/index.html + dist/static/main.js|css (+ copies of frontend/public)
```

`cloud/apps/auth-web`'s `predev`/`prebuild` copy `dist/` into
`public/frames-app/` (`scripts/copy-frames-app-assets.mjs`, keep-existing
fallback when dist is missing), and `app/frames/[[...path]]/route.ts`
serves `index.html` as the SPA fallback for every `/frames/**` path.

## Base-path contract (the load-bearing decision)

One prefix cannot serve all three concerns, so the wrapper splits them via
`FRAMEOS_APP_CONFIG` (handled in `frontend/src/utils/getBasePath.ts`):

| Concern | Config key | Value | Why |
|---|---|---|---|
| API calls | `ingress_path` | `''` (empty) | Cloud paths are already canonical (`/api/frames/...`) at the account origin. `getBasePath()` drives both `apiFetch` and the many direct URL builders (scene images, downloads, upload progress) — an empty base keeps every one of them correct without per-call-site edits. The apiFetch cloud branch additionally skips backend project scoping. |
| SPA routes | `route_base_path` | `/frames` | `urls.ts` and the route tables build navigation URLs from `getRouteBasePath()`, so all links/routes live under `/frames/**` (`/frames`, `/frames/:id`, `/frames/:id/scenes/...`, `/frames/apps/...`) while API URLs stay at the origin root. |
| Public assets | `assets_base_path` | `/frames-app` | Root-absolute assets (`/img/...` logos, `/frameos-wasm/*` preview runtime, `/static/monaco/*`) resolve through `getAssetsBasePath()` to Next's `public/frames-app/`, matching esbuild's `publicPath: '/frames-app/static/'`. |

The alternative — `ingress_path: '/frames'` plus stripping the base inside
apiFetch — was rejected because the shared frontend also builds API URLs
outside apiFetch (entityImagesModel, framesModel downloads,
livePreviewLogic, splitScreenThumbnail, uploadFormDataWithProgress), and
each would have needed its own cloud special case.

Auth: no login/signup scenes are registered; on 401 apiFetch redirects to
the Next.js `/login?return_to=...` page.

## Server-injected config (the two anchors)

Some facts only the server knows, so `src/index.html` carries two named
anchor lines that `app/frames/[[...path]]/route.ts` replaces before serving
the shell — matched as WHOLE lines, because each token also appears in the
comment above the config object and a substring replace rewrites the comment
instead (that exact bug shipped once; see `route.test.ts`):

| Anchor | Injects | Why the client can't compute it |
|---|---|---|
| `//__FRAMEOS_CLOUD_WS_ORIGIN__` | `cloud_ws_origin` | In dev the frame hub is a second process on its own port; in production nginx proxies it same-origin, so nothing is injected. |
| `//__FRAMEOS_CLOUD_APP_CONFIG__` | `cloud_account_url`, `cloud_frames_url`, `cloud_logout_url`, `cloud_scenes_url`, `cloud_origin`, `cloud_claim_token_ttl_hours` | The account/scenes/auth surfaces can live on three origins and `/account/*` shortens on a split host (account header); `cloud_origin` is written into SD images and ESP32 NVS, so it must be the deployment's public URL, not the browser's; the claim-code TTL is deployment-tunable. Read through `src/cloudConfig.ts`. |

`build.mjs` fails the build if either anchor is not exactly one whole line,
and the route answers 503 rather than serving a shell wired to the wrong
origins.

## Add frame

`src/components/AddFramePanel.tsx` (+ `SdImageBuilder`, `Esp32CloudFlasher`,
`lib/sd-image-patch.ts`) is the one enrollment UI: install script, SD image,
link code, ESP32 browser flashing, and reconnecting a wiped board to an
existing frame (the flasher's `reenrollFrame` mode — a claim token bound to
that frame, so the board comes back as the same row instead of a duplicate).
`frontend/` must not import this package,
so `src/main.tsx` registers the drawer through
`frontend/src/scenes/workspace/addFramePanelRegistry.ts`, and FramesHome
opens it because `workspaceSurfaces.addFrameFlows.cloud === 'cloudPanel'`.
The components have no test runner here; they are tested from auth-web's
vitest in `cloud/apps/auth-web/src/test/shared-spa/`.

Known gap: monaco editor workers (`/static/monaco/*.js`) are not built by
this wrapper (same as the on-device wrapper), so the monaco-based editors
fall back to worker-less mode until the workers are added to the bundle.
