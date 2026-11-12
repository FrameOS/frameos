// Which account a Google or Apple sign-in opens, and when it may open one at
// all (docs/auth.md "Account Merging"). Both providers vouch for an email
// address; neither is taken at its word for an account that already exists.
import {
  createDb,
  findAccountByPasswordEmail,
  findIdentity,
  findVerifiedSocialAccountByEmail,
  googleProviderKey,
  socialProviderKeys,
  type SocialProviderKey,
  upsertAccountFromIdentity,
} from "@frameos-cloud/db";

export type ProviderClaims = {
  email?: string | undefined;
  email_verified?: boolean | undefined;
  name?: string | undefined;
  sub: string;
};

export type ProviderSignInResolution =
  // `created` is true only when this sign-in minted a brand new account, so
  // the callback can fire signup-only notifications and skip them on every
  // later login (or when the provider merely linked into an existing account).
  | { status: "ok"; accountId: string; created: boolean }
  // A password account exists for this email but its address was never
  // verified, so the password may have been set by someone who does not own
  // the email. Merging would hand that password-holder the provider user's
  // account (classic pre-hijacking). The provider user must reset the
  // password first: the emailed link proves address ownership and evicts any
  // squatter.
  | { status: "requires_password_reset"; email: string }
  // A verified password account exists for this email. The provider attesting
  // the address is not the same as holding the account: an attacker who signs
  // up for Gmail under a recycled or look-alike address, or who has simply
  // phished the provider side, must not walk into the password account's
  // frames and keys. The visitor proves the password on /login/link (POST
  // /api/auth/link does the linking) before the identity is attached.
  | { status: "requires_link_confirmation"; accountId: string; email: string }
  // The provider did not attest this email, so the visitor has not proven
  // they own it. Password sign-in is the way in.
  | { status: "email_unverified" }
  // A new identity without an address: an account needs one (resets,
  // notices, the deletion check). Apple and Google both send it when asked.
  | { status: "email_missing" }
  // The address already signs in through the other provider. A second,
  // empty account under the same address would look like lost frames, so
  // the visitor is pointed at the way in that account has.
  | { status: "other_provider"; providerKey: SocialProviderKey };

export async function resolveProviderSignIn(
  db: ReturnType<typeof createDb>,
  providerKey: SocialProviderKey,
  issuer: string,
  claims: ProviderClaims,
): Promise<ProviderSignInResolution> {
  const existingIdentity = await findIdentity(db, issuer, claims.sub);

  // An identity we have not seen, whose address the provider itself does not
  // vouch for: no account. It used to get a full session and then a dead end
  // (no password could ever be added to it, since every lookup ignores
  // unverified identities) while a stranger could still register a password
  // account on the same address. An identity linked earlier keeps signing
  // in: its account was verified when the link was made.
  if (!existingIdentity && claims.email_verified !== true) {
    return { status: "email_unverified" };
  }

  if (!existingIdentity) {
    if (!claims.email) {
      return { status: "email_missing" };
    }
    const passwordAccount = await findAccountByPasswordEmail(db, claims.email);
    if (passwordAccount) {
      if (!passwordAccount.emailVerified) {
        return { email: claims.email, status: "requires_password_reset" };
      }
      return {
        accountId: passwordAccount.id,
        email: claims.email,
        status: "requires_link_confirmation",
      };
    }
    const other = await findVerifiedSocialAccountByEmail(
      db,
      claims.email,
      socialProviderKeys.filter((key) => key !== providerKey),
    );
    if (other) {
      return { providerKey: other.providerKey, status: "other_provider" };
    }
  }

  const account = await upsertAccountFromIdentity(db, {
    displayName: claims.name,
    email: claims.email,
    emailVerified: claims.email_verified,
    providerIssuer: issuer,
    providerKey,
    providerSubject: claims.sub,
  });
  return {
    accountId: account.accountId,
    created: account.created,
    status: "ok",
  };
}

export function resolveGoogleSignIn(
  db: ReturnType<typeof createDb>,
  issuer: string,
  claims: ProviderClaims,
) {
  return resolveProviderSignIn(db, googleProviderKey, issuer, claims);
}

export const providerLabels: Record<SocialProviderKey, string> = {
  apple: "Apple",
  google: "Google",
};
