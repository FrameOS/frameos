import Link from "next/link";
import { BackForwardRefresh } from "./BackForwardRefresh";
import { HeaderBrand } from "./HeaderBrand";
import { LegalFooter } from "./LegalFooter";
import {
  getAccountBaseUrl,
  getAccountUrl,
  getCloudBaseUrl,
  getStoreUrl,
} from "../lib/env";

// `title` is the page's heading, shown in the top row after the wordmark.
// The header is the /frames fleet workspace's (cloud-frontend
// AccountHeader.tsx + cloud-chrome.css): same chrome on every surface. The
// wordmark links to /frames — the workspace is the cloud's home — and the
// nav starts there too: Frames, Scenes, Account, (Admin), Sign out.
export function AppShell({
  children,
  isSuperadmin = false,
  noCapture = false,
  title,
}: Readonly<{
  children: React.ReactNode;
  isSuperadmin?: boolean;
  // Marks the page body as off-limits to PostHog autocapture (see
  // lib/analytics-redaction.ts). Set it on any surface whose content is the
  // user's own data — frame names, scene names, install hostnames, other
  // people's email addresses — which is nearly everything behind a login.
  // Pageviews still fire, so traffic to the page is still measured; only the
  // click events that would carry the content are dropped.
  noCapture?: boolean;
  title?: React.ReactNode;
}>) {
  const cloudBaseUrl = getCloudBaseUrl();
  const accountUrl = getAccountUrl();
  const adminUrl = new URL("/admin", getAccountBaseUrl()).toString();
  const logoutUrl = new URL("/api/auth/logout", cloudBaseUrl).toString();
  const scenesUrl = getStoreUrl();
  // The fleet SPA is served from the account origin (app/frames/[[...path]]).
  const framesUrl = new URL("/frames", getAccountBaseUrl()).toString();

  return (
    <div className="shell">
      <header className="frameos-account-header">
        <HeaderBrand href={framesUrl} title={title} />
        <nav aria-label="Primary" className="frameos-account-header__nav">
          <Link className="frameos-account-header__link" href={framesUrl}>
            Frames
          </Link>
          <Link className="frameos-account-header__link" href={scenesUrl}>
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
