CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE consent_decision AS ENUM ('approved', 'denied', 'expired');

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  primary_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_issuer text NOT NULL,
  provider_subject text NOT NULL,
  email_snapshot text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_identities_provider_subject_unique UNIQUE (provider_issuer, provider_subject)
);
CREATE INDEX account_identities_account_idx ON account_identities(account_id);

CREATE TABLE linked_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_display_name text NOT NULL,
  local_origin text,
  provider_client_metadata jsonb,
  token_reference text,
  encrypted_refresh_token text,
  last_seen_at timestamptz,
  last_token_rotation_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX linked_clients_account_idx ON linked_clients(account_id);
CREATE UNIQUE INDEX linked_clients_token_reference_unique ON linked_clients(token_reference);

CREATE TABLE connected_backends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linked_client_id uuid NOT NULL REFERENCES linked_clients(id) ON DELETE CASCADE,
  reported_frameos_version text,
  capabilities jsonb,
  last_sync_at timestamptz,
  last_health_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connected_backends_linked_client_unique
  ON connected_backends(linked_client_id);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  linked_client_id uuid REFERENCES linked_clients(id) ON DELETE SET NULL,
  scopes text[] NOT NULL,
  ip_address text,
  user_agent text,
  decision consent_decision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor jsonb NOT NULL,
  target jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_event_type_idx ON audit_events(event_type);
