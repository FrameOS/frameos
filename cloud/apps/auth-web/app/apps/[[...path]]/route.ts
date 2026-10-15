import { GET as serveFramesAppShell } from "../../frames/[[...path]]/route";

// Next.js reads the route segment config statically, so `runtime` is a
// literal here rather than a re-export.
export const runtime = "nodejs";

// The apps page of the frames workspace SPA lives beside the /frames mount,
// at /apps/** (frontend/src/urls.ts): the same shell, the same injection,
// served by the frames route. Its static assets are root-absolute
// /frames-app/* either way.
export const GET = serveFramesAppShell;
