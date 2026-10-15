import { GET as serveFramesAppShell } from "../frames/[[...path]]/route";

// Next.js reads the route segment config statically, so `runtime` is a
// literal here rather than a re-export.
export const runtime = "nodejs";

// The scene store's front is a page of the frames workspace SPA since
// 2026.10 (frontend/src/scenes/store): signed in, the scenes library;
// signed out, the public store without the workspace around it. The shell
// says which (cloud_signed_in). This is its address when the store shares
// the cloud origin; on its own host the store front is the root (app/route.ts).
export const GET = serveFramesAppShell;
