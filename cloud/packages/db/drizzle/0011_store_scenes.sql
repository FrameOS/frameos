-- FrameOS store (STORE-TODO Phase 1): scenes published by users, npm-style.
-- store_scenes is the package identity (slug, owner, visibility, moderation
-- state); store_scene_versions holds the immutable template-zip payloads —
-- a publish always appends a version, never rewrites one.
CREATE TABLE "store_scenes" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  linked_client_id uuid REFERENCES linked_clients(id) ON DELETE SET NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  -- 'private' | 'public'
  visibility text NOT NULL DEFAULT 'private',
  -- 'active' | 'pulled'; pulled is the moderation kill switch — hidden
  -- everywhere, downloads answer 410.
  status text NOT NULL DEFAULT 'active',
  pulled_reason text,
  pulled_at timestamptz,
  -- Curated by superadmins; null = not featured. Timestamp so the featured
  -- shelf can order by recency.
  featured_at timestamptz,
  latest_version integer NOT NULL DEFAULT 0,
  download_count integer NOT NULL DEFAULT 0,
  preview_image bytea,
  preview_image_type text,
  preview_image_width integer,
  preview_image_height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX store_scenes_slug_unique ON store_scenes (slug);
CREATE INDEX store_scenes_account_idx ON store_scenes (account_id);
CREATE INDEX store_scenes_visibility_status_idx ON store_scenes (visibility, status);

CREATE TABLE "store_scene_versions" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id uuid NOT NULL REFERENCES store_scenes(id) ON DELETE CASCADE,
  published_by_linked_client_id uuid REFERENCES linked_clients(id) ON DELETE SET NULL,
  version integer NOT NULL,
  content bytea NOT NULL,
  content_type text NOT NULL DEFAULT 'application/zip',
  sha256 text NOT NULL,
  size_bytes integer NOT NULL,
  -- Soft-hide a bad version from installs (crates.io-style yank) while
  -- keeping the bytes auditable.
  yanked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_scene_versions_scene_idx ON store_scene_versions (scene_id);
CREATE UNIQUE INDEX store_scene_versions_scene_version_unique
  ON store_scene_versions (scene_id, version);
