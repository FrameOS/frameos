-- What a frame's render process keeps between two pulls that no scene state
-- holds (docs/server-rendering.md "State and events"): its UIs' focus and
-- caret, the open on-screen keyboard, a list's scroll, and its apps'
-- `frameos.remember` values. Every pull runs in a fresh runtime, so without
-- it a tap on a key landed on a form with no keyboard and closed it, and an
-- app forgot what it remembered. The runtime's own JSON
-- (frameos_wasm_kept_state), kept as text and handed back as it was; null
-- when nothing lasts, and after the frame sleeps (a board's RAM does not
-- outlive a deep sleep either).

ALTER TABLE "frame_server_renders"
  ADD COLUMN "kept_state" text;
