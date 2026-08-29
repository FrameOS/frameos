-- Personal API tokens: a bearer credential that stands in for the account on
-- the JSON API (and so for the MCP server at /api/mcp). Until now every
-- account-scoped route accepted only the browser session cookie; a bearer
-- resolved to a linked backend or frame, never to a person. Tokens are minted
-- once, shown once, and stored as a SHA-256 hash like every other secret
-- here. `access` is either 'full' or 'read_only'; the read-only kind is also
-- recognisable from its prefix (fc_apiro_ vs fc_api_) so the CSRF gate can
-- refuse a mutation before touching the database. Sudo-mode routes (frame
-- revoke, device approval) keep requiring a fresh browser session; a token
-- can never do those.
CREATE TABLE "account_api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "access" text NOT NULL DEFAULT 'full',
  "token_hash" text NOT NULL,
  -- The first characters of the token, kept so the list can say which one
  -- a leaked or configured token is without storing the token itself.
  "token_hint" text NOT NULL,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "account_api_tokens_token_hash_unique" ON "account_api_tokens" ("token_hash");
CREATE INDEX "account_api_tokens_account_idx" ON "account_api_tokens" ("account_id");
