"use client";

import { useEffect, useRef } from "react";

// Explicit-render Turnstile widget. Explicit rather than the `cf-turnstile`
// class auto-render because these forms submit through fetch, not a native
// POST — there is no form body for the hidden input to ride along in, so the
// token has to come back through a callback into React state.

declare global {
  interface Window {
    turnstile?: {
      remove: (widgetId: string) => void;
      render: (
        container: HTMLElement,
        options: {
          callback: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
          sitekey: string;
          theme?: "auto" | "dark" | "light";
        },
      ) => string | undefined;
    };
  }
}

const scriptId = "cf-turnstile-script";
const scriptSrc =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.getElementById(scriptId);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.id = scriptId;
    script.src = scriptSrc;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("load failed")));
    document.head.appendChild(script);
  });
}

export function TurnstileWidget({
  onToken,
  siteKey,
}: {
  /** Called with a fresh token, or undefined when it expires or errors. */
  onToken: (token: string | undefined) => void;
  siteKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The callback identity changes on every parent render (it closes over
  // setState); keeping it in a ref means the widget is rendered once instead
  // of being torn down and rebuilt on each keystroke in the form above it.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) {
          return;
        }
        widgetId = window.turnstile.render(containerRef.current, {
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => onTokenRef.current(undefined),
          "expired-callback": () => onTokenRef.current(undefined),
          sitekey: siteKey,
          theme: "auto",
        });
      })
      .catch(() => {
        // Blocked by an extension or an offline CDN. Leave the token unset:
        // the server fails closed, and the form shows its own error on submit
        // rather than this component inventing one.
        onTokenRef.current(undefined);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [siteKey]);

  return <div className="turnstile-widget" ref={containerRef} />;
}
