-- What the voice chat may do on a frame (docs/voice-chat.md, "What the voice
-- chat may do").
--
-- The owner's three switches, plane-side policy the device never sees: the
-- voice route reads them to decide which of the frame-scoped tools the model
-- is offered (and refuses one named anyway).
--
--   voice_permissions — {change_settings, use_scenes, create_scenes}: booleans.
--     NULL = the defaults (settings and the installed scenes allowed, new
--     scenes on the frame not: that one is opted into). Written by
--     POST /api/frames/{id}/voice/permissions, read back on GET /api/frames/{id}
--     as `voice_permissions` with the defaults filled in. Not a `set_settings`
--     key: the firmware has no say in what the chat may do, so the mirror of
--     pushed settings (frames.settings) is the wrong home.

ALTER TABLE "frames"
  ADD COLUMN "voice_permissions" jsonb;
