"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import {
  SENSITIVE_QUERY_PARAMS,
  sanitizeAnalyticsEvent,
} from "../lib/analytics-redaction";

export function PostHogProvider({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "", {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
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
    });
  }, []);
  return <>{children}</>;
}
