import Link from "next/link";
import { BackForwardRefresh } from "./BackForwardRefresh";
import { BrandMark } from "./BrandMark";
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
  signedIn,
  title,
}: Readonly<{
  children: React.ReactNode;
  isSuperadmin?: boolean;
  signedIn: boolean;
  title?: React.ReactNode;
}>) {
  const cloudBaseUrl = getCloudBaseUrl();
  const scenesBaseUrl = getScenesBaseUrl();
  const scenesHomeUrl = new URL("/", scenesBaseUrl).toString();
  const accountUrl = getAccountUrl();
  const adminUrl = new URL("/admin", getAccountBaseUrl()).toString();
  const logoutUrl = new URL("/api/auth/logout", cloudBaseUrl).toString();
  const signInUrl = new URL("/login", cloudBaseUrl);
  signInUrl.searchParams.set("return_to", scenesHomeUrl);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__lead">
            <BrandMark href={scenesHomeUrl} showName={!title} />
            {title ? <span className="topbar__title">{title}</span> : null}
          </div>
          <nav aria-label="Primary" className="nav">
            <Link className="nav-link-button" href={scenesHomeUrl}>
              Scenes
            </Link>
            {signedIn ? (
              <>
                <Link className="nav-link-button" href={accountUrl}>
                  Account
                </Link>
                {isSuperadmin ? (
                  <Link className="nav-link-button" href={adminUrl}>
                    Admin
                  </Link>
                ) : null}
                <form action={logoutUrl} method="post">
                  <button className="nav-link-button" type="submit">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link className="nav-link-button" href={signInUrl.toString()}>
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="content">{children}</main>
      <BackForwardRefresh />
    </div>
  );
}
