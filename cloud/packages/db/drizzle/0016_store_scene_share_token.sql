-- Sharing secret for private store scenes: appending ?share={token} to the
-- scene URL grants read access (page, zip download, scenes.json, images)
-- without an account, so "Install on your FrameOS" links work for private
-- scenes too. High-entropy UUID, shown only to the owner; pulled scenes are
-- never shareable regardless of the token.
ALTER TABLE store_scenes
  ADD COLUMN share_token uuid NOT NULL DEFAULT gen_random_uuid();
