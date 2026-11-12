-- Sign in with Apple (cloud/docs/auth.md "Sign in with Apple").
--
-- Apple requires an app that offers its sign-in to revoke the user's Apple
-- tokens when the account is deleted. The identity row keeps the newest
-- refresh token Apple handed out for it, with the client id it was issued to
-- (the web's Services ID or the iOS app's bundle id: a revoke must name the
-- same one), as `encryptSecret` JSON {client_id, refresh_token}. NULL for
-- every other provider, and for an Apple identity whose token is unknown.

ALTER TABLE "account_identities"
  ADD COLUMN "provider_token_encrypted" text;
