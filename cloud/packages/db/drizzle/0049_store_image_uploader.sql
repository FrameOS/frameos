-- Who uploaded an image that no version binds yet.
--
-- Store images are content-addressed and shared; a row belongs to no scene
-- until a version links it (store_scene_version_images). The owner upload
-- route registered bytes with nothing pointing at them, the quota counted
-- only BOUND bytes, and no sweep ever removed the rest — so an upload that
-- was never saved cost nobody anything and stayed forever (60 × 4 MB per
-- 15 min per IP, on a bucket with a 30-day lock).
--
-- `account_id` names the uploader for as long as the image is unbound:
-- usage.ts meters an account's unbound uploads like private scene bytes,
-- and scripts/object-store-sweep.sh deletes unbound rows older than a week
-- so their objects fall out with the next sweep. Once a version binds the
-- image the column is informational; a deleted account leaves it NULL and
-- the sweep still finds the row through the missing link.
alter table store_images
  add column account_id uuid references accounts(id) on delete set null;

create index store_images_account_id_idx on store_images (account_id)
  where account_id is not null;
