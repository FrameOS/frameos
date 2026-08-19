-- Optional second factors for cloud accounts: an authenticator-app (TOTP)
-- secret, passkeys (WebAuthn credentials), and single-use recovery codes.
--
-- Two-factor is ON for an account exactly when it has a confirmed TOTP row
-- or at least one passkey; there is no separate flag to drift out of sync
-- with the credentials themselves. The TOTP secret is stored encrypted with
-- FRAMEOS_CLOUD_ENCRYPTION_KEY (same as link tokens), recovery codes only as
-- hashes, and passkey public keys in the clear (they are public).

CREATE TABLE "account_totp" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "encrypted_secret" text NOT NULL,
  -- Null while the user is still scanning the QR code; a secret that was
  -- never confirmed with a valid code is not a second factor yet.
  "confirmed_at" timestamptz,
  -- The 30-second step of the last accepted code, so a captured code cannot
  -- be replayed inside its validity window.
  "last_used_step" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "account_passkeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  -- base64url credential id; unique across accounts by WebAuthn design.
  "credential_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "transports" text[],
  "name" text NOT NULL,
  "aaguid" text,
  "device_type" text,
  "backed_up" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
CREATE UNIQUE INDEX "account_passkeys_credential_id_unique"
  ON "account_passkeys" ("credential_id");
CREATE INDEX "account_passkeys_account_idx" ON "account_passkeys" ("account_id");

CREATE TABLE "account_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "account_recovery_codes_account_idx"
  ON "account_recovery_codes" ("account_id");
CREATE UNIQUE INDEX "account_recovery_codes_hash_unique"
  ON "account_recovery_codes" ("account_id", "code_hash");
