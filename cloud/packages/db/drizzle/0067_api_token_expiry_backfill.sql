-- Personal API tokens minted before every token expired (the 90-day default,
-- apps/auth-web/src/lib/api-tokens.ts defaultApiTokenTtlDays) still carry a
-- NULL expiry and would work forever. Give each of them the default counted
-- from today, not from its mint date, so no script stops working the day
-- this ships: the owner gets the same ninety days a new token would. Job
-- tokens are minted with a TTL by scripts/accounting-service-account.sh and
-- are left alone either way.
UPDATE "account_api_tokens"
SET "expires_at" = now() + interval '90 days'
WHERE "expires_at" IS NULL
  AND "revoked_at" IS NULL
  AND "access" IN ('full', 'read_only');
