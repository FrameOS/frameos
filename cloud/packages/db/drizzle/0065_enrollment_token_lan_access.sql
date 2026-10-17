-- The LAN access choice made in "Add frame" for a frame set up with the
-- install script (docs/lan-access.md). That path has no SD card or USB
-- console to carry it, so the claim token does, and enrollment queues
-- `lan_access_set {enabled: false}` when the owner left it off. Turning it
-- off needs no code on the frame; "on" is what a frame with no stored value
-- already is. Nullable: older tokens and the SD / USB paths, which carry the
-- choice themselves.
ALTER TABLE "frame_enrollment_tokens"
  ADD COLUMN "lan_access" boolean;
