"use client";

import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect } from "react";
import {
  analyticsConfigured,
  consentChangeEvent,
  readConsentFromDocument,
} from "../lib/analytics-consent";
import {
  SENSITIVE_QUERY_PARAMS,
  isSuppressedUrl,
  sanitizeAnalyticsEvent,
} from "../lib/analytics-redaction";

// Consent decides whether anything is captured; the suppressed paths
// (/admin) override it. `before_send` already drops every event from those
// pages; opting the SDK out on top means it does not even try — no pageview,
// no flag fetch, no session-recording decision — while the superadmin
// tooling is open. Leaving the page re-applies the visitor's consent.
function applyConsent(pathname: string | null) {
  if (isSuppressedUrl(pathname ?? window.location.pathname)) {
    posthog.opt_out_capturing();
    return;
  }
  if (readConsentFromDocument() === "granted") {
    // Only now does anything reach disk: PostHog's own cookie/localStorage
    // entry is created here, not at init.
    posthog.set_config({ persistence: "localStorage+cookie" });
    posthog.opt_in_capturing();
  } else {
    posthog.opt_out_capturing();
    // Withdrawal has to clear what was already stored, not just stop new
    // events — otherwise the identifier survives the withdrawal.
    posthog.set_config({ persistence: "memory" });
    posthog.reset();
  }
}

export function PostHogProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  useEffect(() => {
    if (!analyticsConfigured()) {
      return;
    }
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "", {
      // `|| default`, not `??`: CI may inline an empty string here, and an
      // empty api_host would send events nowhere (matches error-tracking.ts
      // and posthog-capture.ts).
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() ||
        "https://eu.i.posthog.com",
      defaults: "2026-05-30",
      // Analytics runs on every route of this app, including pages whose URL
      // is itself a credential (/recovery?token=…, /s/<slug>?share=…). These
      // settings keep those out of PostHog; the reasoning, and why both the
      // native masking and the hook are here, is in analytics-redaction.ts.
      mask_personal_data_properties: true,
      custom_personal_data_properties: SENSITIVE_QUERY_PARAMS,
      before_send: sanitizeAnalyticsEvent,
      // Autocapture records every attribute of every element in the clicked
      // chain, which is how scene preview images (attr__src) and share links
      // (attr__href) would end up in analytics. The `ph-sensitive` class does
      // NOT cover attributes — only an element's own text and an anchor's
      // href — so the only reliable answer is to drop attributes wholesale.
      // Clicks are still captured, with the element's text and position.
      mask_all_element_attributes: true,
      // Browser-side error tracking — the client half of what
      // lib/error-tracking.ts does on the server. Same PostHog project, so
      // there is still exactly one analytics processor to name in the privacy
      // policy, which is the reason this is not Sentry.
      capture_exceptions: true,
      // Nothing is captured and nothing is persisted until the visitor
      // accepts. Analytics storage needs opt-in consent, and consent that is
      // collected after the fact is not consent — so the SDK starts fully
      // opted out, in memory only, and is switched on by the effect below if
      // and when the banner is answered.
      opt_out_capturing_by_default: true,
      persistence: "memory",
    });

    const onConsentChange = () => applyConsent(window.location.pathname);
    onConsentChange();
    window.addEventListener(consentChangeEvent, onConsentChange);
    return () => window.removeEventListener(consentChangeEvent, onConsentChange);
  }, []);

  // Client-side navigation into or out of a suppressed path.
  useEffect(() => {
    if (!analyticsConfigured()) {
      return;
    }
    applyConsent(pathname);
  }, [pathname]);

  return <>{children}</>;
}
