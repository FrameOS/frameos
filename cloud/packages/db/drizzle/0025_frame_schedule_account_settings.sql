-- Wake/event schedule pushed to the device via set_schedule; stored so the
-- Schedule panel renders current state and edits survive an offline device.
ALTER TABLE "frames" ADD COLUMN "schedule" jsonb;

-- Account-level service settings (API keys scenes use) — the cloud mirror of
-- the backend's per-project settings table. One row per settings group;
-- auth-web's allow-list decides which groups/fields are storable.
CREATE TABLE "account_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX account_settings_account_key_unique ON account_settings (account_id, key);
