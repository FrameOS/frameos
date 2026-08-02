"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

export function UserIdentifier({
  email,
  name,
  userId,
}: {
  email?: string | null | undefined;
  name?: string | null | undefined;
  userId: string;
}) {
  useEffect(() => {
    posthog.identify(userId, {
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    });
  }, [userId, email, name]);
  return null;
}
