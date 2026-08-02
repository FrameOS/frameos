-- Cloud-managed frames (docs/cloud-frames.md at the repo root is the wire
-- contract; cloud/docs/cloud-frames.md is the design). A frame is 1:1 with a
-- linked_clients row (client_kind = 'frame'); the device holds the private
-- key, we store only the Ed25519 public key — the control plane can never
-- impersonate a device.

CREATE TABLE "frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"linked_client_id" uuid NOT NULL REFERENCES "linked_clients"("id") ON DELETE cascade,
	"name" text NOT NULL,
	-- base64 raw Ed25519 public key, verify-only. Never a private key.
	"public_key" text NOT NULL,
	"hardware" jsonb,
	"frameos_version" text,
	-- pending (enrolled via claim token, awaiting owner confirmation)
	-- | active | revoked. No scene push is accepted while pending.
	"status" text DEFAULT 'pending' NOT NULL,
	-- Hub liveness, DB-keyed so a second instance is possible later.
	"connected" boolean DEFAULT false NOT NULL,
	"hub_session_id" text,
	"last_seen_at" timestamp with time zone,
	"last_state" jsonb,
	"last_metrics" jsonb,
	-- Desired vs device-acked interpreted-scene payload checksums.
	"assigned_checksum" text,
	"scenes_checksum" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX frames_account_idx ON frames (account_id);
CREATE UNIQUE INDEX frames_linked_client_unique ON frames (linked_client_id);

-- Claim tokens minted by "Add frame" (FRCT_…), hashed at rest like device
-- codes. Single-use here; 0021 adds max_uses/use_count so one SD image can
-- enroll several cards. A use is spent only by an enrollment that commits —
-- a failed attempt leaves the budget intact.
CREATE TABLE "frame_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"frame_id" uuid REFERENCES "frames"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX frame_enrollment_tokens_token_hash_unique
  ON frame_enrollment_tokens (token_hash);
CREATE INDEX frame_enrollment_tokens_account_idx
  ON frame_enrollment_tokens (account_id);

-- Which store/account scenes a frame should render. scene_version NULL means
-- track the latest non-yanked version. Writes enqueue a set_scenes command.
CREATE TABLE "frame_scene_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"frame_id" uuid NOT NULL REFERENCES "frames"("id") ON DELETE cascade,
	"scene_id" uuid NOT NULL REFERENCES "store_scenes"("id") ON DELETE cascade,
	"scene_version" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX frame_scene_assignments_frame_scene_unique
  ON frame_scene_assignments (frame_id, scene_id);
CREATE INDEX frame_scene_assignments_frame_idx
  ON frame_scene_assignments (frame_id, position);

-- Durable per-frame command queue: survives restarts, drained in
-- (created_at, id) order on (re)connect — the id is a random uuid and orders
-- nothing. The hub marks sent/acked/failed; expired rows are swept by
-- db-cleanup.sh.
CREATE TABLE "frame_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"frame_id" uuid NOT NULL REFERENCES "frames"("id") ON DELETE cascade,
	"type" text NOT NULL,
	"payload" jsonb,
	-- pending | sent | acked | failed | expired
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE set null,
	"expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX frame_commands_frame_status_idx
  ON frame_commands (frame_id, status, created_at);

-- Retained device logs (scope telemetry:logs). size_bytes is precomputed so
-- storage-usage sums stay cheap; retention is capped per frame on insert and
-- in db-cleanup.sh. Retained bytes count toward the account's storage usage.
CREATE TABLE "frame_logs" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"frame_id" uuid NOT NULL REFERENCES "frames"("id") ON DELETE cascade,
	"timestamp" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX frame_logs_frame_idx ON frame_logs (frame_id, id);
