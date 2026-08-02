-- FrameOS store hardening (STORE-TODO Phase 3): publish bans, risk flags
-- (shell-command detection), and user reports.

-- Account-level publish ban: separate from deletion, keeps existing scenes
-- (pull them individually if needed) but rejects any new publish.
ALTER TABLE accounts ADD COLUMN store_banned_at timestamptz;
ALTER TABLE accounts ADD COLUMN store_ban_reason text;

-- Risk flags computed at publish from the scenes JSON (e.g. 'shell' when a
-- scene configures shell/exec apps or code that shells out). Stored on the
-- version they were computed from and denormalized onto the scene for
-- listings; text[] so new flags need no migration.
ALTER TABLE store_scene_versions ADD COLUMN risk_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE store_scenes ADD COLUMN risk_flags text[] NOT NULL DEFAULT '{}';

-- User reports (Steam Workshop-style flagging): signed-in users report a
-- scene, superadmins work an open-reports queue.
CREATE TABLE "store_scene_reports" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id uuid NOT NULL REFERENCES store_scenes(id) ON DELETE CASCADE,
  reporter_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  reason text NOT NULL,
  -- 'open' | 'resolved'
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  resolved_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_scene_reports_scene_idx ON store_scene_reports (scene_id);
CREATE INDEX store_scene_reports_status_idx ON store_scene_reports (status);
-- One open report per (scene, reporter): reporting twice is a no-op, not spam.
CREATE UNIQUE INDEX store_scene_reports_open_unique
  ON store_scene_reports (scene_id, reporter_account_id)
  WHERE status = 'open';
