-- The storage snapshot gains the photo library (docs/photos.md): the bytes of
-- an account's photos in the object store, the bucket a user sees as
-- "Photos" on their usage page and the admin sees on /admin/storage.
ALTER TABLE "account_storage_usage" ADD COLUMN "photo_bytes" bigint DEFAULT 0 NOT NULL;
