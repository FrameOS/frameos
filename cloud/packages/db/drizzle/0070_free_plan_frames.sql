-- The free plan holds 20 frames of your own, down from 50
-- (cloud/docs/accounting-todo.md §0.1). The paid stops multiply it, so $2 is
-- 40. FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT is the floor beside this row and
-- defaults to 20 as well; a deployment that pins it higher keeps its number.
UPDATE "billing_plans"
   SET "entitlements" = jsonb_set("entitlements", '{frames}', '20'::jsonb),
       "updated_at" = now()
 WHERE "code" = 'payg';
