import { redirect } from "next/navigation";
import { getAccountUrl } from "../../../src/lib/env";

// The account pages — backends, settings, usage, backups, activity,
// security, developer — are pages of the /frames workspace since 2026.10
// (frontend/src/scenes/settings/account). In production the surface router
// (src/lib/surfaces.ts) redirects their old URLs before this renders; this
// covers the single-origin dev setup and any path the router leaves alone.
// getAccountPath (src/lib/env.ts) holds the table; a section it does not
// know lands on the first page.
export default async function AccountSectionPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  const path = `/account${section?.length ? `/${section.join("/")}` : ""}`;
  const target = getAccountUrl(path);
  redirect(target.includes("/frames/") ? target : getAccountUrl("/account"));
}
