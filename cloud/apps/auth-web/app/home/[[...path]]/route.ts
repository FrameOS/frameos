import { GET as serveFramesAppShell } from "../../frames/[[...path]]/route";

// Next.js reads the route segment config statically, so `runtime` is a
// literal here rather than a re-export.
export const runtime = "nodejs";

// The frames workspace SPA's home page (hello, recent frames and albums,
// usage), behind the rail's logo, beside the /frames mount: the same shell,
// the same injection, served by the frames route.
export const GET = serveFramesAppShell;
