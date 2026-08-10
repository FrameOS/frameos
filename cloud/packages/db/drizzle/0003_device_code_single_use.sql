ALTER TABLE device_authorization_requests
  ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;
