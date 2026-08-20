import { redirect } from "next/navigation";
import { getMyScenesUrl } from "../../src/lib/env";

// The old clean alias of the private scene list. In production the surface
// router (src/lib/surfaces.ts) redirects before this renders; this covers
// the single-origin dev setup.
export default function LegacyScenesPage() {
  redirect(getMyScenesUrl());
}
