-- Additional gallery images for a store scene, uploaded by the owner from the
-- scene page (the primary preview image still comes from the published zip
-- and lives on store_scenes).
CREATE TABLE store_scene_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id uuid NOT NULL REFERENCES store_scenes(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  content bytea NOT NULL,
  content_type text NOT NULL DEFAULT 'image/jpeg',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_scene_images_scene_idx ON store_scene_images (scene_id, position);
