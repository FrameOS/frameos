-- First-party auth: password credentials and the superadmin flag live on the
-- account; password identities are rows in account_identities keyed on the
-- normalized email.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS password_hash text;

-- Single-use password reset tokens. Only the token hash is stored; redemption
-- marks the row used so a leaked reset link cannot be replayed.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  token_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_token_hash_unique ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx ON password_reset_tokens (account_id);
