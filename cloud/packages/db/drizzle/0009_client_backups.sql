-- Config backups pushed by linked backends and frames (CLOUD-TODO Phase 3):
-- scene template collections (backup:templates) and frame metadata + scene
-- JSON (backup:frames). Backups belong to the owning account, not the linked
-- client, so a reinstalled backend that relinks to the same account can still
-- restore them; linked_client_id only records which install pushed the copy.
CREATE TABLE "client_backups" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_client_id uuid REFERENCES linked_clients(id) ON DELETE SET NULL,
  kind text NOT NULL,
  item_key text NOT NULL,
  name text,
  content bytea NOT NULL,
  content_type text,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_backups_account_idx ON client_backups (account_id);
CREATE INDEX client_backups_linked_client_idx ON client_backups (linked_client_id);
-- One live copy per (account, kind, item); a new push replaces the old one.
CREATE UNIQUE INDEX client_backups_account_kind_item_unique
  ON client_backups (account_id, kind, item_key);
