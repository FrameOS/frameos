-- Re-enrollment: a claim token minted FOR an existing frame. Redeeming one
-- re-keys that frame (new device public key, rotated link token) instead of
-- inserting a second row, so moving a board to another account's frame or
-- rescuing one whose NVS was blanked stops forking a duplicate.
--
-- Deliberately NOT the existing frame_id column: that one records which frame
-- a token created, and a multi-use SD-image token acquires it on its first
-- redemption — treating that as "bound" would re-key the first board's frame
-- on every card flashed afterwards.
--
-- ON DELETE CASCADE: a token whose frame is gone can never do anything.
ALTER TABLE "frame_enrollment_tokens"
  ADD COLUMN "bound_frame_id" uuid REFERENCES "frames"("id") ON DELETE CASCADE;
