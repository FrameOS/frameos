// Which primary-nav entry a path belongs to. The header is one component on
// every surface (AppShell, PublicShell, and the /frames SPA's copy), so the
// mapping lives here rather than in any one shell.
export type HeaderNavSection = "frames" | "scenes" | "account" | "admin";

const scenePrefixes = ["/store", "/scenes", "/s/", "/my-scenes", "/publishers"];

export function activeHeaderSection(
  pathname: string | null | undefined,
): HeaderNavSection | undefined {
  const path = pathname ?? "";
  if (path === "/frames" || path.startsWith("/frames/")) {
    return "frames";
  }
  if (path === "/account" || path.startsWith("/account/")) {
    return "account";
  }
  if (path === "/admin" || path.startsWith("/admin/")) {
    return "admin";
  }
  if (
    path === "/" ||
    scenePrefixes.some((prefix) => path === prefix || path.startsWith(prefix))
  ) {
    return "scenes";
  }
  return undefined;
}
