CREATE TYPE device_authorization_status AS ENUM ('pending', 'approved', 'denied', 'expired');

CREATE TABLE device_authorization_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  user_code_display text NOT NULL,
  public_display_name text NOT NULL,
  local_origin text,
  requested_scopes text[] NOT NULL,
  backend_metadata jsonb,
  status device_authorization_status NOT NULL DEFAULT 'pending',
  interval_seconds integer NOT NULL DEFAULT 5,
  poll_count integer NOT NULL DEFAULT 0,
  last_poll_at timestamptz,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  approved_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  denied_at timestamptz,
  linked_client_id uuid REFERENCES linked_clients(id) ON DELETE SET NULL,
  token_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_authorization_requests_status_idx
  ON device_authorization_requests(status);
