// When Google last had the person prove who they are, for sudo mode.
//
// A fresh session counts as a recent proof of the credentials
// (recent-auth.ts), and for an account whose only credential is Google the
// proof is a round trip to Google. That round trip is silent while the
// browser is signed in to Google: whoever sits at an unlocked laptop gets a
// "fresh" session by opening the sign-in link. `prompt=login` on the reauth
// start asks Google to re-prompt, but the parameter rides the browser's URL
// and nothing in the answer said whether Google did.
//
// Google's ID token can say: `auth_time`, sent when the request's `claims`
// parameter asks for it AND the OAuth client has the claim switched on in
// Google's console (off by default). So this is the operator's switch,
// GOOGLE_REQUIRE_AUTH_TIME=1, set after turning the claim on there. With it:
// every Google start asks for the claim, and the session a Google sign-in
// mints proved its credentials when `auth_time` says, not now. A token
// without the claim (the request was tampered with, or the console switch
// is off) proves nothing recent. Without the switch nothing changes.

/** The authorization request's `claims` parameter that asks for auth_time. */
export const googleAuthTimeClaims = JSON.stringify({
  id_token: { auth_time: { essential: true } },
});

// A clock a little ahead of ours is still Google's clock.
const skewSeconds = 300;

/**
 * When the session a Google sign-in mints last proved its credentials:
 * undefined for "now" (the switch is off), else the token's auth_time, or
 * the epoch when the token has none worth believing.
 */
export function googleAuthenticatedAt(
  authTime: unknown,
  required: boolean,
  now = Date.now(),
): Date | undefined {
  if (!required) {
    return undefined;
  }
  if (
    typeof authTime !== "number" ||
    !Number.isFinite(authTime) ||
    authTime <= 0 ||
    authTime > now / 1000 + skewSeconds
  ) {
    return new Date(0);
  }
  return new Date(Math.min(authTime * 1000, now));
}
