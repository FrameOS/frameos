-- A frame that joins the cloud already running scenes of its own used to
-- arrive empty: the hub protocol had no device -> cloud scene path, so the
-- frame kept rendering what it had and the workspace listed nothing.
--
-- frame_device_scenes is the hub's half: the latest answer to the `scenes_get`
-- verb (docs/cloud-frames.md), one row per frame. The hub asks a confirmed
-- frame that reports scenes in its hello while it has no assignments, and
-- stores the reply here; the workspace then offers "Import scenes from this
-- frame" and auth-web does the importing (store publishing needs moderation,
-- object storage and quotas, none of which the hub has).
--
-- `payload` is the device's JSON document as sent — bytea, not jsonb: it is
-- untrusted text of up to 8 MiB that only the importer parses, and jsonb
-- would refuse a \u0000 the device is free to send. It is dropped (NULL) as
-- soon as the owner imports or dismisses; what stays is the verdict, so the
-- hub stops asking and the banner stays gone.
CREATE TABLE "frame_device_scenes" (
  "frame_id" uuid PRIMARY KEY NOT NULL REFERENCES "frames"("id") ON DELETE CASCADE,
  -- ready | importing | imported | dismissed. `importing` is the importer's
  -- claim (one import at a time per frame); a claim older than ten minutes is
  -- a crashed import and may be taken over.
  "status" text DEFAULT 'ready' NOT NULL,
  "payload" bytea,
  "size_bytes" integer DEFAULT 0 NOT NULL,
  -- What the banner shows without opening the payload: [{id, name}…], capped.
  "scenes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scene_count" integer DEFAULT 0 NOT NULL,
  -- Compiled scenes the device counted and did not send.
  "skipped_compiled" integer DEFAULT 0 NOT NULL,
  -- The PUBLIC id of the scene the frame was showing, so the import's push
  -- leaves it on screen.
  "active_scene" text,
  -- The import's outcome ({imported, reused, skipped, assigned}) for the
  -- activity feed and a second look.
  "result" jsonb,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- When the row entered its current status.
  "status_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- store_scene_imports is the dedupe ledger. A re-enrolled frame (a deleted and
-- re-added frame, a second account frame flashed from the same card) reports
-- the same scenes again, and minting a second draft of each would fork the
-- owner's library on every enrolment. One row per (account, scene content):
-- `content_sha256` is the digest of the scene's canonical JSON with its
-- `origin` stamp removed, so the copy the cloud pushed back — which carries a
-- stamp the original never had — still matches. Rows die with their scene, so
-- a draft the owner deleted is simply imported again.
CREATE TABLE "store_scene_imports" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "scene_id" uuid NOT NULL REFERENCES "store_scenes"("id") ON DELETE CASCADE,
  "scene_version" integer NOT NULL,
  -- The scene's runtime id on the device (scenes.json `id`).
  "device_scene_id" text NOT NULL,
  "content_sha256" text NOT NULL,
  -- Provenance only; the frame may be long gone.
  "frame_id" uuid REFERENCES "frames"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "store_scene_imports_account_content_unique" ON "store_scene_imports" ("account_id", "content_sha256");
-- The two cascades above delete by these columns.
CREATE INDEX "store_scene_imports_scene_idx" ON "store_scene_imports" ("scene_id");
CREATE INDEX "store_scene_imports_frame_idx" ON "store_scene_imports" ("frame_id") WHERE "frame_id" IS NOT NULL;
