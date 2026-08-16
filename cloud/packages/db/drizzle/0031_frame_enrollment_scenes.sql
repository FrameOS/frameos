-- Provisioning-time scene intent: "the frame this card/board enrolls should
-- start with the same scenes as <existing frame>".
--
-- Two columns because the intent has to survive two hops. The token carries
-- it (the browser that built the SD image is long gone by the time the card
-- is flashed), and the frame carries it from enrollment to confirmation —
-- a MULTI-USE card enrolls many frames, so frame_enrollment_tokens.frame_id
-- (which each enrollment overwrites) cannot be read backwards to answer
-- "which token enrolled me".
--
-- Nothing is pushed to the device from either column: the copy happens when
-- the OWNER confirms the frame, through the same assignScenesToFrame gates a
-- workspace deploy runs (accessibility, pinned version, shell-risk refusal).
-- Until then a pending board has been sent nothing.
--
-- ON DELETE SET NULL: deleting the source frame must not delete the new one,
-- it just means there is nothing left to copy.
ALTER TABLE "frame_enrollment_tokens"
  ADD COLUMN "scene_source_frame_id" uuid REFERENCES "frames"("id") ON DELETE SET NULL;

ALTER TABLE "frames"
  ADD COLUMN "scene_source_frame_id" uuid REFERENCES "frames"("id") ON DELETE SET NULL;
