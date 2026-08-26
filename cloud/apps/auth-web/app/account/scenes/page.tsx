import { redirect } from "next/navigation";
import { getMyScenesUrl } from "../../../src/lib/env";

// The private scene list moved to the scene store's "My scenes" tab
// (app/my-scenes). In production the surface router (src/lib/surfaces.ts)
// redirects before this page renders; this covers the single-origin dev setup.
export default function AccountScenesPage() {
  redirect(getMyScenesUrl());
}
