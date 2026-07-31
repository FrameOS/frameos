-- Revocable server-side sessions backing the session cookie JWT.
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

-- Single-use opaque FrameOS login handoff codes (replaces PII-carrying JWT codes).
CREATE TABLE IF NOT EXISTS frameos_login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  linked_client_id uuid NOT NULL REFERENCES linked_clients(id) ON DELETE CASCADE,
  profile jsonb NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS frameos_login_codes_code_hash_unique ON frameos_login_codes (code_hash);
CREATE INDEX IF NOT EXISTS frameos_login_codes_linked_client_idx ON frameos_login_codes (linked_client_id);

-- Grace window for link-token rotation so a backend that never received the
-- rotation response is not permanently locked out.
ALTER TABLE linked_clients
  ADD COLUMN IF NOT EXISTS previous_token_reference text,
  ADD COLUMN IF NOT EXISTS previous_token_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS linked_clients_previous_token_reference_idx
  ON linked_clients (previous_token_reference);

-- Indexes for foreign keys used by account-history queries.
CREATE INDEX IF NOT EXISTS device_authorization_requests_approved_by_account_idx
  ON device_authorization_requests (approved_by_account_id);
CREATE INDEX IF NOT EXISTS device_authorization_requests_linked_client_idx
  ON device_authorization_requests (linked_client_id);
CREATE INDEX IF NOT EXISTS consent_events_account_idx ON consent_events (account_id);
CREATE INDEX IF NOT EXISTS consent_events_linked_client_idx ON consent_events (linked_client_id);
CREATE INDEX IF NOT EXISTS audit_events_account_idx ON audit_events (account_id);

-- Stored user codes are masked: keeping the full code in plaintext next to its
-- hash would let a database reader race the user and approve pending requests.
UPDATE device_authorization_requests
SET user_code_display = substr(user_code_display, 1, 4) || '-****'
WHERE user_code_display NOT LIKE '%-****';

COMMENT ON COLUMN accounts.primary_email IS
  'Display/contact snapshot only. Not unique; never use for account lookup or recovery. Identity is keyed on account_identities (provider_issuer, provider_subject).';
