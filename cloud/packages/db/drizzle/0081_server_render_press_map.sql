-- Where a press on a server-rendered frame's picture does something
-- (docs/server-rendering.md "The click"): the runtime's press map
-- (frameos_wasm_press_map), `x0,y0,x1,y1` entries in the panel's pixels.
-- Sent with the picture as X-FrameOS-Press, so the board clicks at a press
-- it takes the moment the finger lands instead of after a pull. One for the
-- picture drawn last and one for the picture drawn ahead of a wake; null
-- when nothing takes a press.

ALTER TABLE "frame_server_renders"
  ADD COLUMN "picture_press_map" text,
  ADD COLUMN "prerender_press_map" text;
