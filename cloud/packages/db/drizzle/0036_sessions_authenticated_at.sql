-- Re-authentication ("sudo mode") for sensitive actions: when did this session
-- last prove the account's credentials? Set at sign-in and pushed forward by
-- /api/auth/reauth; routes that revoke frames or links, or approve device
-- grants, require it to be recent. Existing sessions inherit their creation
-- time, so a long-lived cookie has to re-prove itself once before it can do
-- any of that.
ALTER TABLE "sessions"
  ADD COLUMN "authenticated_at" timestamptz NOT NULL DEFAULT now();
UPDATE "sessions" SET "authenticated_at" = "created_at";
