-- The plan catalog (cloud/docs/accounting-todo.md §0.1, revised 2026-10-25):
-- Free, Plus ($2 to $49 a month) and Business ($10 to $499). The paid tiers
-- are a price list in apps/auth-web/src/lib/plan-catalog.ts and get their
-- billing_plans rows when the first one is activated.
--
-- `payg` keeps its code (subscriptions and the ledger tests name it) and is
-- called Free on every page now. Its photo storage stays out of the row: the
-- free plan's number is FRAMEOS_CLOUD_MAX_PHOTO_MB, 250 MB by default.
UPDATE "billing_plans"
   SET "name" = 'Free',
       "description" = 'Your own frames, the scene store, photos and backups. AI is billed for what you use.',
       "updated_at" = now()
 WHERE "code" = 'payg';

-- Maker and Studio were the 2026-09-01 sketch and nobody was moved onto
-- them. Kept for the ledger tests and any hand-made subscription, gone from
-- every listing.
UPDATE "billing_plans"
   SET "public" = false,
       "updated_at" = now()
 WHERE "code" IN ('maker', 'studio');
