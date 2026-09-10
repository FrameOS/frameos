-- Indexes on the foreign-key columns that carry an ON DELETE action but had
-- no index (2026-09 review). Postgres does not index the referencing side of
-- a foreign key: deleting a frame, a store scene, a linked client or an
-- account then scans every referencing table in full for the rows to
-- cascade or null out. With frame_logs-sized tables that is a long lock
-- under the account-deletion route.
--
-- Nullable columns get a partial index — nearly every row is NULL and the
-- planner uses `WHERE col IS NOT NULL` for `col = $1` just the same.
--
-- Deliberately NOT indexed: the four ON DELETE NO ACTION references inside
-- the ledger (ledger_account_groups.parent_id, ledger_accounts.group_id,
-- ai_usage_records.event_id, subscriptions.plan_code). Nothing deletes
-- those parents; the reference is there to refuse it.

CREATE INDEX IF NOT EXISTS "frameos_login_codes_identity_idx"
  ON "frameos_login_codes" ("identity_id") WHERE "identity_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_scenes_linked_client_idx"
  ON "store_scenes" ("linked_client_id") WHERE "linked_client_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_scene_versions_published_by_linked_client_idx"
  ON "store_scene_versions" ("published_by_linked_client_id")
  WHERE "published_by_linked_client_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_scene_reports_reporter_account_idx"
  ON "store_scene_reports" ("reporter_account_id") WHERE "reporter_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_scene_reports_resolved_by_account_idx"
  ON "store_scene_reports" ("resolved_by_account_id") WHERE "resolved_by_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frames_scene_source_frame_idx"
  ON "frames" ("scene_source_frame_id") WHERE "scene_source_frame_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_enrollment_tokens_frame_idx"
  ON "frame_enrollment_tokens" ("frame_id") WHERE "frame_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_enrollment_tokens_bound_frame_idx"
  ON "frame_enrollment_tokens" ("bound_frame_id") WHERE "bound_frame_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_enrollment_tokens_scene_source_frame_idx"
  ON "frame_enrollment_tokens" ("scene_source_frame_id") WHERE "scene_source_frame_id" IS NOT NULL;
--> statement-breakpoint
-- (frame_id, scene_id) is unique, but scene_id is its second column: a
-- store scene's deletion cascading into its assignments had no index.
CREATE INDEX IF NOT EXISTS "frame_scene_assignments_scene_idx"
  ON "frame_scene_assignments" ("scene_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_commands_created_by_account_idx"
  ON "frame_commands" ("created_by_account_id") WHERE "created_by_account_id" IS NOT NULL;
