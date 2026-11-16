# The playground: playground.frameos.net

A frame in the browser, the size of the window, for anyone: the repo's scenes
running side by side on the **Windows 98** desktop, the Scene store, the
Asset browser and the Terminal on its desktop, and the Control Panel (the
frame's own page). Nothing is installed, nothing is saved anywhere but the
visitor's own browser.

## What it is

- **One page of the cloud app**, `app/playground` (`src/components/Playground.tsx`,
  the work in `src/lib/playground.ts`). `src/lib/surfaces.ts` serves it at the
  root of `FRAMEOS_PLAYGROUND_APP_URL` (production: `playground.frameos.net`)
  and sends every other page on that host to the cloud; without the setting
  it is `/playground` on the cloud origin, as in `pnpm dev`. The root is not
  a rewrite returned by the proxy: the proxy marks the request
  (`playgroundRootHeader`) and `next.config.ts` rewrites it inside Next's
  router (`playgroundRootRewrite`). A rewrite returned by the proxy left the
  server behind nginx (Next listens on `127.0.0.1` and the proxy only sees
  `localhost`, so the two origins never match) and came back as a request
  the routing sent to the root again: a redirect loop. A curl of the dev
  server does not show it; a production build started with
  `HOSTNAME=127.0.0.1` does.
- **The runtime the cloud ships**: `public/frameos-wasm`, the signed release
  bundle pinned in `versions.json` (`scripts/lib/wasm-runtime.mjs`), driven
  through the `frameos-wasm` package. It runs `windowed` (scenes side by side,
  `docs/scene-layouts.md` "Windows"), with the `framePage` (the Control
  Panel is the frame's own page, `docs/scene-settings.md`; its Restart and
  Reboot start the runtime again, a new scale is kept across them) and the Windows 98 layout chosen for every
  scene (`chooseLayout`) once it is ready. The visitor can choose another
  layout in the Control Panel; a reload starts in Windows 98 again.
- **The scenes**: `scripts/build-playground-scenes.mjs` (predev / prebuild)
  writes `public/playground-assets/scenes.json` from `repo/scenes/samples`
  and `repo/scenes/gallery`, leaving out the samples that need an API key or
  an account in the frame's settings, or a process on a Pi (its
  `excludedTemplates`). `leadingTemplates` is the Start menu's order; the
  first is the window the desktop opens on.
- **The network**: the Scene store browses and previews from the page's own
  origin (`storeUrl`), and a scene's request the browser's CORS refuses goes
  through the store's anonymous preview proxy (`/api/store/preview-proxy`),
  which accepts the playground's origin by name. The playground is no app
  origin otherwise (`getAppOrigins`): no sign-in, no return-to, no passkeys.
- **The frame's size** is the window's in CSS pixels, capped at 2560 x 1600
  (`playgroundSize`) and stretched beyond; a resize is taken in place
  (`frameos_wasm_resize`), the windows kept.

## When it changes

It is part of auth-web, so it ships with every cloud deploy
(`.github/workflows/cloud-ci.yml`): a change to the page, to `repo/scenes`
(a new sample), to `frameos/wasm`, and a FrameOS release (the
`workflow_run` trigger, which installs the new pinned runtime) each put a new
playground on `playground.frameos.net`. Nothing deploys it on its own.

Cloud-only by nature: a self-hosted backend has its own scenes and frames,
and the `frameos-wasm` package's options (`windowed`, `framePage`,
`storeUrl`, `resize`, `chooseLayout`) are there for any page that wants the
same.
