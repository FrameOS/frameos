"use client";

import { useEffect, useState } from "react";
import {
  clearConsentInDocument,
  consentChangeEvent,
  readConsentFromDocument,
  writeConsentToDocument,
  type ConsentChoice,
} from "../lib/analytics-consent";

// The banner, plus the "Cookie settings" link that reopens it. Rendered on
// every page through the root layout.
//
// It is deliberately not a modal and does not block the page: consent has to
// be freely given, and a wall that only clears on "Accept" is the textbook
// example of consent that is not. Analytics simply stays off until answered.

export function AnalyticsConsentBanner({
  cookieDomain,
}: {
  cookieDomain?: string | undefined;
}) {
  // Undefined until the effect runs: the server has no idea what the visitor
  // chose, and rendering a guess would either flash the banner at people who
  // already answered or hide it from people who have not.
  const [choice, setChoice] = useState<ConsentChoice | undefined>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setChoice(readConsentFromDocument());
    setReady(true);
    const onChange = () => setChoice(readConsentFromDocument());
    window.addEventListener(consentChangeEvent, onChange);
    return () => window.removeEventListener(consentChangeEvent, onChange);
  }, []);

  if (!ready || choice) {
    return null;
  }

  function decide(next: ConsentChoice) {
    writeConsentToDocument(next, cookieDomain);
    setChoice(next);
  }

  return (
    <aside
      aria-label="Cookie consent"
      className="consent-banner"
      // Never let a click on the banner itself become an analytics event.
      data-ph-no-capture=""
    >
      <div className="consent-banner__copy">
        <strong>Analytics, only if you say so.</strong>{" "}
        <span className="copy">
          We would like to record which pages you visit and what breaks, using
          PostHog in the EU, to work out what to fix next. It is not required
          and nothing else changes if you decline. Details in our{" "}
          <a href="/legal/privacy">Privacy Policy</a>.
        </span>
      </div>
      <div className="consent-banner__actions">
        {/* Identical styling on purpose, and no button-primary on "Accept".
            EDPB guidance treats a visually louder accept button as a nudge
            that undermines consent being freely given, so neither answer gets
            the emphasis — the CSS matches their widths for the same reason. */}
        <button
          className="button"
          onClick={() => decide("denied")}
          type="button"
        >
          Decline
        </button>
        <button
          className="button"
          onClick={() => decide("granted")}
          type="button"
        >
          Accept
        </button>
      </div>
    </aside>
  );
}

// Footer entry point for changing your mind, on every page. Clearing the
// stored choice stops capture at once (PostHogProvider listens to the same
// event) and brings the banner back so a new choice can be made.
export function CookieSettingsButton({
  cookieDomain,
}: {
  cookieDomain?: string | undefined;
}) {
  return (
    <button
      className="footer-link-button"
      onClick={() => clearConsentInDocument(cookieDomain)}
      type="button"
    >
      Cookie settings
    </button>
  );
}
