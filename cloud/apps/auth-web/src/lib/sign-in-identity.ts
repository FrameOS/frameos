// Which of an account's identities a session minted WITHOUT a provider
// round-trip (passwordless passkey sign-in) speaks for.
//
// A session names one account_identities row (provider issuer + subject),
// and downstream readers depend on it: /api/frameos/login/authorize looks
// the row up to mint a login code and answers linked_client_required when
// there is none, and /api/device/authorize snapshots it into approvedBy. A
// passkey is not an identity — it is a credential on the account — so the
// route has to pick one, and it has to pick the SAME one every time, or the
// self-hosted backend ends up mapping one person to different local users
// depending on how they signed in that day.
//
// Order: the password identity (what the password route stamps, so the two
// sign-in methods agree), then any verified identity, then whatever is
// left — oldest first, id as the tie-break. The caller passes the rows
// already ordered by (created_at, id) so this stays a pure function.
import { passwordProviderIssuer } from "@frameos-cloud/db";

export type SignInIdentityRow = {
  createdAt: Date;
  emailSnapshot: string | null;
  emailVerified: boolean;
  id: string;
  providerIssuer: string;
  providerSubject: string;
};

export function pickSignInIdentity<T extends SignInIdentityRow>(
  rows: readonly T[],
): T | undefined {
  const ordered = [...rows].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  return (
    ordered.find((row) => row.providerIssuer === passwordProviderIssuer) ??
    ordered.find((row) => row.emailVerified) ??
    ordered[0]
  );
}
