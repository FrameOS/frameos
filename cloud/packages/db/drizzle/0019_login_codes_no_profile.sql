-- frameos_login_codes stored a profile snapshot (email, name, provider
-- claims) as jsonb. Keep only account/identity references and resolve the
-- profile at redemption, so the row carries no PII and a stale snapshot can
-- never be released. In-flight codes only live two minutes; deleting them is
-- cheaper than backfilling.
DELETE FROM "frameos_login_codes";
ALTER TABLE "frameos_login_codes" ADD COLUMN "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "frameos_login_codes" ADD COLUMN "identity_id" uuid REFERENCES "account_identities"("id") ON DELETE SET NULL;
ALTER TABLE "frameos_login_codes" DROP COLUMN "profile";
CREATE INDEX "frameos_login_codes_account_idx" ON "frameos_login_codes" ("account_id");
