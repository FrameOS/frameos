import { getAppOrigins } from "./env";

// Transient cookies carrying the Google OAuth roundtrip state. mergeEmail
// carries the address of a pending Google-link merge so the login warning and
// the reset form can show it without putting PII in the URL.
export const authCookieNames = {
  mergeEmail: "frameos_merge_email",
  returnTo: "frameos_oauth_return_to",
  state: "frameos_oauth_state",
  nonce: "frameos_oauth_nonce",
  verifier: "frameos_oauth_verifier",
};

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  };
}

export function safeAuthReturnPath(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    if (value.startsWith("/") && !value.startsWith("//")) {
      const parsed = new URL(value, "http://frameos.local");
      if (parsed.origin !== "http://frameos.local") {
        return undefined;
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      !getAppOrigins().has(parsed.origin)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
