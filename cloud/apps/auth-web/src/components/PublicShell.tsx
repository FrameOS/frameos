import { BackForwardRefresh } from "./BackForwardRefresh";
import { HeaderBrand } from "./HeaderBrand";
import { HeaderNav, type HeaderNavLink } from "./HeaderNav";
import { LegalFooter } from "./LegalFooter";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getStoreUrl,
} from "../lib/env";

// Shell for the public store pages: same chrome as AppShell but usable
// signed out. A signed-in visitor sees the cloud header exactly as the app
// shell draws it — "FrameOS Cloud" linking to the workspace, then Frames /
// Scenes / Account / (Admin) / Sign out. Signed out, the store stands on its
// own: the wordmark reads "FrameOS Scenes" and links to the store root, and
// the only action is Sign in.
// `title` is the page's heading, shown in the top row after the wordmark.
export function PublicShell({
  children,
  isSuperadmin = false,
  noCapture = false,
  signedIn,
  title,
}: Readonly<{
  children: React.ReactNode;
  isSuperadmin?: boolean;
  // As AppShell's: suppresses autocapture for the page body. The store is
  // public by definition, so this is off by default and set only for the
  // views that are not — a private scene reached through its share link.
  noCapture?: boolean;
  signedIn: boolean;
  title?: React.ReactNode;
}>) {
  const cloudBaseUrl = getCloudBaseUrl();
  const scenesHomeUrl = getStoreUrl();
  const accountUrl = getAccountUrl();
  // The fleet workspace is served from the account origin (app/frames).
  const framesUrl = new URL("/frames", getAccountBaseUrl()).toString();
  const adminUrl = new URL("/admin", getAccountBaseUrl()).toString();
  const logoutUrl = new URL("/api/auth/logout", cloudBaseUrl).toString();
  const signInUrl = new URL("/login", cloudBaseUrl);
  signInUrl.searchParams.set("return_to", scenesHomeUrl);
  // Ordered as in AppShell. Signed-out visitors get none of this: they have
  // no frames, so the links would only bounce them through the login page.
  const links: HeaderNavLink[] = [
    { href: framesUrl, label: "Frames", section: "frames" },
    { href: scenesHomeUrl, label: "Scenes", section: "scenes" },
    { href: accountUrl, label: "Account", section: "account" },
    ...(isSuperadmin
      ? [{ href: adminUrl, label: "Admin", section: "admin" as const }]
      : []),
  ];

  return (
    <div className="shell">
      <header className="frameos-account-header">
        {signedIn ? (
          <HeaderBrand href={framesUrl} title={title} />
        ) : (
          <HeaderBrand
            href={scenesHomeUrl}
            name="FrameOS Scenes"
            title={title}
          />
        )}
        {signedIn ? (
          <HeaderNav links={links} logoutUrl={logoutUrl} />
        ) : (
          <HeaderNav links={[]} signInUrl={signInUrl.toString()} />
        )}
      </header>
      <main className={noCapture ? "content ph-no-capture" : "content"}>
        {children}
      </main>
      <LegalFooter />
      <BackForwardRefresh />
    </div>
  );
}
