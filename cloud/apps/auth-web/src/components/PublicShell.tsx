import Link from "next/link";
import { BackForwardRefresh } from "./BackForwardRefresh";
import { HeaderBrand } from "./HeaderBrand";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getScenesBaseUrl,
} from "../lib/env";

// Shell for the public store pages: same chrome as AppShell but usable
// signed out — signed-in visitors get the same nav as the app shell
// (Account / Admin / Sign out), everyone else gets Sign in.
// `title` is the page's heading, shown in the top row next to the logo.
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
        <HeaderBrand href={scenesHomeUrl} title={title} />
        <nav aria-label="Primary" className="frameos-account-header__nav">
          <Link className="frameos-account-header__link" href={scenesHomeUrl}>
            Scenes
          </Link>
          {signedIn ? (
            <>
              {/* Signed-in only, and ordered as in AppShell (Scenes, Frames,
                  Account): a signed-out visitor has no frames, so the link
                  would only bounce them through the login page. */}
              <Link className="frameos-account-header__link" href={framesUrl}>
                Frames
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
      <BackForwardRefresh />
    </div>
  );
}
