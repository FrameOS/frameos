-- Rendering on the server (docs/server-rendering.md): what the cloud keeps for
-- a hardware frame it renders for, an ESP32-C3 or a board whose owner set
-- `render_mode` to "remote". The device pulls the packed picture from
-- GET /api/frames/{id}/embedded/render; one row per such frame holds the
-- memory a render needs between two pulls and the pictures it hands out.
--
--   active_scene     — the scene drawn last, or the one a switch named.
--   states           — every scene's state after its last render.
--   pending_states   — state a verb sent (a switch's state, setSceneState),
--                      folded into `states` by the next render once it is
--                      filtered to the scene's public fields.
--   pending_events   — scene events waiting for the next render.
--   revision         — moved by every change a picture depends on that the
--                      device cannot name: a kept picture is good only at
--                      its own revision.
--   picture*         — the last FOSB handed out, its ETag, and what it was
--                      drawn for (scene, revision, panel, scene bundle).
--   prerender*       — a picture drawn before a sleeping frame's wake, as of
--                      the wake's render time, with the state it left; the
--                      pull at the wake takes it once, if nothing changed.

CREATE TABLE "frame_server_renders" (
  "frame_id" uuid PRIMARY KEY REFERENCES "frames"("id") ON DELETE CASCADE,
  "active_scene" text,
  "states" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pending_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pending_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "picture" bytea,
  "picture_etag" text,
  "picture_scene" text,
  "picture_revision" integer,
  "picture_panel" text,
  "picture_scenes_checksum" text,
  "rendered_at" timestamp with time zone,
  "render_ms" integer,
  "render_error" text,
  "prerender" bytea,
  "prerender_etag" text,
  "prerender_scene" text,
  "prerender_revision" integer,
  "prerender_panel" text,
  "prerender_as_of" timestamp with time zone,
  "prerender_state" jsonb,
  "prerender_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
