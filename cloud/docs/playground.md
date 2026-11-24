# The playground: playground.frameos.net

A frame in the browser, the size of the window, for anyone: the repo's scenes
running side by side on the **Windows 98** desktop, the Scene store,
Files and the Terminal on its desktop, and the Control Panel (the
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
  first is the window the desktop opens on: the **Welcome**
  (`playground-scenes/Welcome`, one JSX app), which says what the visitor is
  looking at and opens the store, the Terminal, Control Panel and the scene
  list from its buttons. It is the playground's alone, kept beside this page
  and not in `repo/scenes`, whose every template also reaches frames and the
  AI's catalog: its words are about a frame in a browser. Every real-time and interactive
  sample is in it (Pixel toys, Color cycling, the Kitchen sink, DVD Logo
  Bounce, the Keyboard and Touch tests, the Terminal, and the store's Real
  time shelf as samples: Form showcase, Map, Now playing, To-do, Colors,
  Calculator, Home, Clock, Weather demo, Steps, Gallery, Tap counter;
  and Theme roles, every role of a desktop's theme in the look of the
  desktop chosen in the Control Panel; `playground.test.ts` holds them
  there): a scene the playground should show is a sample.
- **The network**: the Scene store browses and previews from the page's own
  origin (`storeUrl`), and a scene's request the browser's CORS refuses goes
  through the store's anonymous preview proxy (`/api/store/preview-proxy`),
  which accepts the playground's origin by name. The playground is no app
  origin otherwise (`getAppOrigins`): no sign-in, no return-to, no passkeys.
- **Its host is no door to the API.** The scenes it runs are anyone's, and
  the session cookie is scoped to the registrable domain, so the browser
  sends it to this host too. On the playground's own host `proxy.ts`
  answers `404` for every `/api/*` path but the three things the playground
  asks for (`playgroundServesApi` in `surfaces.ts`: the store's listing for
  frames, a public scene's files, the preview proxy) and takes the cookie
  and any `Authorization` off every request before a page or a route reads
  it, so those are answered as to a stranger. Something new the playground
  needs from the API goes on that list, and must be fine to serve to
  anyone.
- **Files from the computer**: the Files scene's Upload and Download open the
  browser's file picker or save the file (docs/scene-store.md "The Files
  app"); when the tap's gesture ran out before the request came, the page asks
  with a bar of its own ("Choose files" / "Save", `onFileRequest` in
  `startPlayground`). What is uploaded stays in the visitor's browser, in the
  preview's IndexedDB folder. A release from before has neither button.
- **The keyboard** is the frame's while the canvas has the focus: every key's
  default is prevented (`startPlayground`), so a desktop's Super bindings get
  Cmd+L, Cmd+F or Cmd+1 instead of the address bar, the find bar or a tab.
  What a browser reserves (Cmd+W, Cmd+T, Cmd+Q) and what the operating system
  keeps (Cmd+Space, Cmd+Tab on a Mac) it keeps: a desktop that binds Super
  takes another key for it too (Omarchy's "Super key", Super or Ctrl by
  default; no Mac browser binds Ctrl).
- **The frame's size** is the window's in CSS pixels, capped at 2560 x 1600
  (`playgroundSize`) and stretched beyond; a resize is taken in place
  (`frameos_wasm_resize`), the windows kept.

## Working on it

`pnpm dev`'s `playground` pane (`mprocs.yaml`, `pnpm run dev:playground` in
`cloud/`, `scripts/playground-dev.mjs`) is the cloud's dev server with the
playground on this checkout's runtime: it prints the address to open
(`http://localhost:3000/playground`, or the port Next took).

- **The runtime** is the one the `wasm` pane builds
  (`frontend/public/frameos-wasm`, `FRAMEOS_WASM_SOURCE=local`), installed
  again after every rebuild. The release the cloud ships is behind `main`, so
  a playground on it shows a sample written for a newer runtime without what
  it needs (the Scene store's covers, until a release has `<img src>`).
- **The scenes** (`repo/scenes/samples`, `repo/scenes/gallery`,
  `playground-scenes`) and the `frameos-wasm` package are built again when
  they change. Reload the page to see any of it.
- **The Scene store** browses `cloud.frameos.net`
  (`FRAMEOS_PLAYGROUND_STORE_URL`; empty for the page's own origin). The
  runtime asks its page's own origin only through the preview proxy, and the
  proxy's guard refuses localhost.
- It is the cloud's dev server, so it runs **instead of** the `cloud` pane:
  Next refuses a second dev server in `apps/auth-web`, and both would install
  their runtime into the same `public/frameos-wasm`. It needs the database
  like `cloud` (`scripts/db-setup.sh`, the `postgres` pane).

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
