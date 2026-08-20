import Link from "next/link";
import { BackForwardRefresh } from "./BackForwardRefresh";
import { HeaderBrand } from "./HeaderBrand";
import { LegalFooter } from "./LegalFooter";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getScenesBaseUrl,
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
  const scenesBaseUrl = getScenesBaseUrl();
  const scenesHomeUrl = new URL("/", scenesBaseUrl).toString();
  const accountUrl = getAccountUrl();
  // The fleet workspace is served from the account origin (app/frames).
  const framesUrl = new URL("/frames", getAccountBaseUrl()).toString();
  const adminUrl = new URL("/admin", getAccountBaseUrl()).toString();
  const logoutUrl = new URL("/api/auth/logout", cloudBaseUrl).toString();
  const signInUrl = new URL("/login", cloudBaseUrl);
  signInUrl.searchParams.set("return_to", scenesHomeUrl);

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
        <nav aria-label="Primary" className="frameos-account-header__nav">
          {signedIn ? (
            <>
              {/* Ordered as in AppShell. Signed-out visitors get none of
                  this: they have no frames, so the links would only bounce
                  them through the login page. */}
              <Link className="frameos-account-header__link" href={framesUrl}>
                Frames
              </Link>
              <Link
                className="frameos-account-header__link"
                href={scenesHomeUrl}
              >
                Scenes
              </Link>
              <Link className="frameos-account-header__link" href={accountUrl}>
                Account
              </Link>
              {isSuperadmin ? (
                <Link className="frameos-account-header__link" href={adminUrl}>
                  Admin
                </Link>
              ) : null}
              <form action={logoutUrl} method="post">
                <button className="frameos-account-header__link" type="submit">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              className="frameos-account-header__link"
              href={signInUrl.toString()}
            >
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main className={noCapture ? "content ph-no-capture" : "content"}>
        {children}
      </main>
      <LegalFooter />
      <BackForwardRefresh />
    </div>
  );
}
