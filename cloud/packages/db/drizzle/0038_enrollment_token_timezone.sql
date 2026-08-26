-- The IANA time zone of the browser that minted the claim token ("Add frame").
-- A board cannot know where it is, so enrollment seeds the new frame's
-- `timezone` setting from this; frames used to come up on UTC and show the
-- wrong time until someone debugged it. Nullable: older tokens and callers
-- that do not send one.
ALTER TABLE "frame_enrollment_tokens"
  ADD COLUMN "timezone" text;
