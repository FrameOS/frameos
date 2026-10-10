-- One row per run of the host's off-box backups (cloud/ops/backup: the
-- nightly pg_dump + host tarball, and the object-store copy). The scripts
-- insert it through psql when they finish, so the admin overview can say how
-- many backups have been made and when the last one ran, without shelling
-- out to rclone or pgbackrest from the web app.
--
-- Not the backups themselves (those are on the Storage Box) and not
-- client_backups (the self-hosted backends' uploads).
CREATE TABLE "backup_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- "database" (pg-backup.sh) or "objects" (object-store-backup.sh)
  "kind" text NOT NULL,
  "ok" boolean NOT NULL,
  "bytes" bigint,
  "summary" text,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- "last run" and "runs in the last N days" both read the newest rows.
CREATE INDEX "backup_runs_finished_idx" ON "backup_runs" ("finished_at");
