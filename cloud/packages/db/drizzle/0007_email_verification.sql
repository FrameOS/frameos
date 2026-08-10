-- Single-use email verification tokens for password signups. Only the token
-- hash is stored; redemption marks the row used and flips email_verified on
-- the password identity.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  token_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_token_hash_unique ON email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS email_verification_tokens_account_idx ON email_verification_tokens (account_id);
