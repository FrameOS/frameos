-- When the scene wants its next picture (docs/server-rendering.md "When the
-- next picture is due"): the seconds the cloud tells a board it renders for,
-- from the render's nextSleep, else the scene's refreshInterval, held between
-- the plan's floor and seven days. Kept with each picture, so a reused
-- picture, a kept pre-render and a 304 answer for the picture they stand for.
-- Null: the scene had no opinion, and the board keeps the frame's interval.

ALTER TABLE "frame_server_renders"
  ADD COLUMN "picture_next_render_seconds" integer,
  ADD COLUMN "prerender_next_render_seconds" integer;
