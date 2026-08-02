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
| SPA routes | `route_base_path` | `/frames` | `urls.ts` and the route tables build navigation URLs from `getRouteBasePath()`, so all links/routes live under `/frames/**` (`/frames`, `/frames/frames/:id`, `/frames/scenes/...`) while API URLs stay at the origin root. |
| Public assets | `assets_base_path` | `/frames-app` | Root-absolute assets (`/img/...` logos, `/frameos-wasm/*` preview runtime, `/static/monaco/*`) resolve through `getAssetsBasePath()` to Next's `public/frames-app/`, matching esbuild's `publicPath: '/frames-app/static/'`. |

The alternative — `ingress_path: '/frames'` plus stripping the base inside
apiFetch — was rejected because the shared frontend also builds API URLs
outside apiFetch (entityImagesModel, framesModel downloads,
livePreviewLogic, splitScreenThumbnail, uploadFormDataWithProgress), and
each would have needed its own cloud special case.

Auth: no login/signup scenes are registered; on 401 apiFetch redirects to
the Next.js `/login?return_to=...` page.

Known gap: monaco editor workers (`/static/monaco/*.js`) are not built by
this wrapper (same as the on-device wrapper), so the monaco-based editors
fall back to worker-less mode until the workers are added to the bundle.
