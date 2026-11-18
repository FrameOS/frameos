-- How long a sign-in lets the in-browser preview read the account's saved
-- service keys (GET /api/settings?reveal=1) before it asks to confirm it is
-- you again (cloud/docs/auth.md "Re-authentication"). NULL = the default
-- two hours; 0 = for as long as the session lasts. The owner picks it on the
-- Security page; loosening it takes a recent confirmation itself.

ALTER TABLE "accounts" ADD COLUMN "saved_keys_reauth_seconds" integer;
