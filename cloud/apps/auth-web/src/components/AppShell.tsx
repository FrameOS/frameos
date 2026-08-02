import Link from "next/link";
import { BackForwardRefresh } from "./BackForwardRefresh";
import { BrandMark } from "./BrandMark";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getScenesBaseUrl,
} from "../lib/env";

// `title` is the page's heading, shown in the top row next to the logo.
export function AppShell({
  children,
  isSuperadmin = false,
  title,
}: Readonly<{
  children: React.ReactNode;
  isSuperadmin?: boolean;
  title?: React.ReactNode;
}>) {
  const cloudBaseUrl = getCloudBaseUrl();
  const accountUrl = getAccountUrl();
  const adminUrl = new URL("/admin", getAccountBaseUrl()).toString();
  const logoutUrl = new URL("/api/auth/logout", cloudBaseUrl).toString();
  const scenesUrl = new URL("/", getScenesBaseUrl()).toString();
  // The fleet SPA is served from the account origin (app/frames/[[...path]]).
  const framesUrl = new URL("/frames", getAccountBaseUrl()).toString();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__lead">
            <BrandMark href={accountUrl} showName={!title} />
            {title ? <span className="topbar__title">{title}</span> : null}
          </div>
          <nav aria-label="Primary" className="nav">
            <Link className="nav-link-button" href={scenesUrl}>
              Scenes
            </Link>
            <Link className="nav-link-button" href={framesUrl}>
              Frames
            </Link>
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
          </nav>
        </div>
      </header>
      <main className="content">{children}</main>
      <BackForwardRefresh />
    </div>
  );
}
