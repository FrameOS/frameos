-- The tone a scene asked for in a picture drawn ahead of a sleeping frame's
-- wake (docs/tones.md): the runtime's notes (frameos_wasm_tones),
-- "hz:ms,..." with 0 Hz a rest. Sent with that picture as X-FrameOS-Tone at
-- the pull that takes it, so a reminder due at the wake sounds then. A
-- picture rendered at the pull sends its tone straight away and keeps none:
-- a tone is heard once, never from a kept picture. Null: no tone.

ALTER TABLE "frame_server_renders"
  ADD COLUMN "prerender_tones" text;
