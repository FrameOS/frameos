-- Virtual frames (docs/cloud-frames.md "Virtual frames"): a frame with no
-- hardware behind it. Its device half runs in the frame hub, which renders
-- the frame's scenes with the wasm runtime and keeps the picture for a view
-- link. One row per virtual frame holds what a device would keep on its own
-- disk; a frames row with no row here is hardware, whatever it reports.
--
--   view_token      — the link's secret (`vf_…`), kept as text so the owner
--                     can copy the link again. Whoever has it sees the
--                     frame's picture and nothing else; regenerating it ends
--                     every copy of the old link.
--   scenes, scenes_checksum — the last scene bundle the device was pushed
--                     (`set_scenes`), preview pushes included.
--   active_scene, states — the scene it shows and every scene's state: a
--                     render is a fresh runtime each time, so this row is
--                     its memory.
--   refresh_seconds — the shown scene's own refresh interval, when it has
--                     one. NULL falls back to the frame's interval.
--   rendered_at, render_ms, render_error, image_version — the last render:
--                     when, how long, what went wrong, and a digest of the
--                     picture for the view link's ETag.
--   viewed_at       — when the view link was last read. With
--                     frames.preview_watched_at it decides whether the
--                     frame is rendered at all: a picture nobody looks at
--                     is not drawn again.

CREATE TABLE "virtual_frames" (
  "frame_id" uuid PRIMARY KEY REFERENCES "frames"("id") ON DELETE CASCADE,
  "view_token" text NOT NULL,
  "scenes" jsonb,
  "scenes_checksum" text,
  "active_scene" text,
  "states" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "refresh_seconds" integer,
  "rendered_at" timestamp with time zone,
  "render_ms" integer,
  "render_error" text,
  "image_version" text,
  "viewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "virtual_frames_view_token_unique" ON "virtual_frames" ("view_token");
