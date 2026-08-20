import { redirect } from "next/navigation";
import { getFramesUrl } from "../../../src/lib/env";

// The account frame table is gone — the /frames workspace is the one frames
// page (it confirms pending enrollments and revokes links itself). In
// production the surface router (src/lib/surfaces.ts) redirects before this
// page renders; this covers the single-origin dev setup.
export default function AccountFramesPage() {
  redirect(getFramesUrl());
}
