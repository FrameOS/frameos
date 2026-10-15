import { GET as serveFramesAppShell } from "../frames/[[...path]]/route";

// Next.js reads the route segment config statically, so `runtime` is a
// literal here rather than a re-export.
export const runtime = "nodejs";

// The scenes library of the frames workspace SPA (the public store, the
// private scenes, a frame's installed scenes; frontend/src/scenes/store):
// signed in the library, signed out the public store, decided by the SPA
// from cloud_signed_in. /scenes/<slug> stays the legacy scene page redirect
// (app/scenes/[slug]). Until 2026.10 this address was the private scene
// list's alias, which now lives at /my-scenes.
export const GET = serveFramesAppShell;
