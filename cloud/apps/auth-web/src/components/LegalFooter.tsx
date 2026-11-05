import { CookieSettingsButton } from "./AnalyticsConsent";
import { getCloudBaseUrl, getPricingUrl, getSessionCookieDomain } from "../lib/env";
import { getSupportEmail } from "../lib/legal";

// The imprint and the privacy policy have to be reachable from every page —
// that is what "easily, directly and permanently accessible" means in the
// e-Commerce Directive, and a page nobody can navigate to does not count.
//
// The price list (on the product site) and the support address sit beside
// them: what a plan costs and who to write to must be findable from any
// page, signed in or out.
//
// Absolute URLs: these pages live on the cloud origin, and the footer also
// renders on account.frameos.net and scenes.frameos.net, where a bare
// "/legal/terms" would 404 in production.
export function LegalFooter() {
  const cloudBaseUrl = getCloudBaseUrl();
  const legalUrl = (path: string) => new URL(path, cloudBaseUrl).toString();
  const supportEmail = getSupportEmail();

  return (
    <footer className="legal-footer">
      <nav aria-label="Legal">
        <a href={getPricingUrl()}>Pricing</a>
        <a href={legalUrl("/legal/terms")}>Terms</a>
        <a href={legalUrl("/legal/privacy")}>Privacy</a>
        <a href={legalUrl("/legal/refunds")}>Refunds</a>
        <a href={legalUrl("/legal/imprint")}>Imprint</a>
        {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : null}
        <CookieSettingsButton cookieDomain={getSessionCookieDomain()} />
      </nav>
    </footer>
  );
}
