-- Asset browsing for cloud-managed frames (docs/cloud-frames.md,
-- `assets_list` / `asset_get`): the hub caches the latest device-reported
-- listing per frame, plus a small per-frame LRU of fetched file bytes so
-- thumbnails and repeat downloads stop round-tripping to the device.
CREATE TABLE "frame_assets" (
  "frame_id" uuid PRIMARY KEY REFERENCES "frames"("id") ON DELETE cascade,
  "payload" jsonb NOT NULL,
  "size_bytes" integer NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "frame_asset_files" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "frame_id" uuid NOT NULL REFERENCES "frames"("id") ON DELETE cascade,
  "path" text NOT NULL,
  "thumb" boolean DEFAULT false NOT NULL,
  "content_type" text NOT NULL,
  "content" "bytea" NOT NULL,
  "size_bytes" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "frame_asset_files_frame_path_thumb_idx"
  ON "frame_asset_files" ("frame_id", "path", "thumb");
