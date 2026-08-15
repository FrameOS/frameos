import { CookieSettingsButton } from "./AnalyticsConsent";
import { getCloudBaseUrl, getSessionCookieDomain } from "../lib/env";

// The imprint and the privacy policy have to be reachable from every page —
// that is what "easily, directly and permanently accessible" means in the
// e-Commerce Directive, and a page nobody can navigate to does not count.
//
// Absolute URLs: these pages live on the cloud origin, and the footer also
// renders on account.frameos.net and scenes.frameos.net, where a bare
// "/legal/terms" would 404 in production.
export function LegalFooter() {
  const cloudBaseUrl = getCloudBaseUrl();
  const legalUrl = (path: string) => new URL(path, cloudBaseUrl).toString();

  return (
    <footer className="legal-footer">
      <nav aria-label="Legal">
        <a href={legalUrl("/legal/terms")}>Terms</a>
        <a href={legalUrl("/legal/privacy")}>Privacy</a>
        <a href={legalUrl("/legal/imprint")}>Imprint</a>
        <CookieSettingsButton cookieDomain={getSessionCookieDomain()} />
      </nav>
    </footer>
  );
}
