-- The store's Video shelf (2026-11-28; categories.ts, docs/scene-store.md
-- "Categories"). The scenes that play video were filed under Photos (Video
-- player, Immich videos) or Art & galleries (Archive films, Slow movie):
-- every scene on those two shelves whose version needs `video`
-- (frameos.video / videoFrame / videoInfo, sceneNeeds.ts; migration 0084)
-- moves to Video, the row and each version alike, as 0084 moved Real time's.
-- The video scenes on other shelves (Camera wall and Video from URL, under
-- Notes & tools) stay where they are.

UPDATE "store_scenes" SET "category" = 'video'
WHERE "category" IN ('photos', 'art') AND 'video' = ANY("needs");

UPDATE "store_scene_versions" SET "category" = 'video'
WHERE "category" IN ('photos', 'art') AND 'video' = ANY("needs");
