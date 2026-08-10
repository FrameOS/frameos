"use client";

import { useEffect } from "react";

export function BackForwardRefresh() {
  useEffect(() => {
    function refreshIfRestored(event: PageTransitionEvent) {
      if (event.persisted) {
        window.location.reload();
      }
    }

    window.addEventListener("pageshow", refreshIfRestored);
    return () => window.removeEventListener("pageshow", refreshIfRestored);
  }, []);

  return null;
}
