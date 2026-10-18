-- Which accounts have uploaded the bytes of a store image.
--
-- Images are content-addressed, and a version binds them by digest
-- (POST /api/account/scenes/{id}/content `images`). Binding checked only
-- that the digest was registered, so a digest learned anywhere bound
-- another account's image — a private scene's cover is often a personal
-- photo — into the caller's own scene, where its owner view serves the
-- bytes. A digest is now bindable by an account that uploaded those bytes
-- itself (this table) or already has them in one of its own versions
-- (src/lib/store-images.ts, resolveImageSet). store_images.account_id keeps
-- only the FIRST uploader, and two accounts may well upload the same bytes,
-- hence a row per (image, account).
--
-- Rows go with the image (the unbound sweep in
-- scripts/object-store-sweep.sh deletes store_images rows) and with the
-- account. Backfilled from the uploader every existing image records.
create table store_image_uploads (
  sha256 text not null references store_images(sha256) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sha256, account_id)
);

create index store_image_uploads_account_idx on store_image_uploads (account_id);

insert into store_image_uploads (sha256, account_id)
select sha256, account_id from store_images where account_id is not null;
