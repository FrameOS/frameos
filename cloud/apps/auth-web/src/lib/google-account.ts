import {
  createDb,
  findAccountByPasswordEmail,
  findIdentity,
  googleProviderKey,
  linkIdentityToAccount,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";

export type GoogleClaims = {
  email?: string | undefined;
  email_verified?: boolean | undefined;
  name?: string | undefined;
  sub: string;
};

export type GoogleSignInResolution =
  // `created` is true only when this sign-in minted a brand new account, so
  // the callback can fire signup-only notifications and skip them on every
  // later login (or when Google merely linked into an existing account).
  | { status: "ok"; accountId: string; created: boolean }
  // A password account exists for this email but its address was never
  // verified, so the password may have been set by someone who does not own
  // the email. Merging would hand that password-holder the Google user's
  // account (classic pre-hijacking). The Google user must reset the password
  // first: the emailed link proves address ownership and evicts any squatter.
  | { status: "requires_password_reset"; email: string }
  // The password account is fine, but Google did not attest this email, so
  // the visitor has not proven they own it. Password sign-in is the way in.
  | { status: "google_email_unverified" };

export async function resolveGoogleSignIn(
  db: ReturnType<typeof createDb>,
  issuer: string,
  claims: GoogleClaims,
): Promise<GoogleSignInResolution> {
  const existingIdentity = await findIdentity(db, issuer, claims.sub);

  if (!existingIdentity && claims.email) {
    const passwordAccount = await findAccountByPasswordEmail(db, claims.email);
    if (passwordAccount) {
      if (claims.email_verified !== true) {
        return { status: "google_email_unverified" };
      }
      if (!passwordAccount.emailVerified) {
        return { email: claims.email, status: "requires_password_reset" };
      }

      await linkIdentityToAccount(db, {
        accountId: passwordAccount.id,
        email: claims.email,
        emailVerified: true,
        providerIssuer: issuer,
        providerKey: googleProviderKey,
        providerSubject: claims.sub,
      });
      return { accountId: passwordAccount.id, created: false, status: "ok" };
    }
  }

  const account = await upsertAccountFromIdentity(db, {
    displayName: claims.name,
    email: claims.email,
    emailVerified: claims.email_verified,
    providerIssuer: issuer,
    providerKey: googleProviderKey,
    providerSubject: claims.sub,
  });
  return {
    accountId: account.accountId,
    created: account.created,
    status: "ok",
  };
}
