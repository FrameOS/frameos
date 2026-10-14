-- Photos (docs/photos.md): a library of albums per account that frames play
-- through share links. Metadata lives here, bytes in the object store under
-- random keys (`photos/<account id>/<random>`): the bucket's CDN alias serves
-- any key without authentication, so a content hash would be a key anyone
-- holding the same photo could compute.
--
-- photo_entries holds files AND folders. Folder rows are explicit so an empty
-- album exists; every row's parent folder has a row of its own (the root ""
-- has none). `path` is relative to the library root, `/`-separated, validated
-- by the app (src/lib/photos/paths.ts). Moves and renames rewrite the paths of
-- a whole subtree in one statement; prefix queries are
-- `path = $p OR starts_with(path, $p || '/')`, which needs no LIKE escaping.
CREATE TABLE "photo_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  -- file | folder
  "kind" text NOT NULL,
  -- Files: the stored bytes. Folders: 0 (their size is summed on read).
  "size_bytes" bigint DEFAULT 0 NOT NULL,
  -- Sniffed from the bytes at upload, never taken from the client.
  "content_type" text,
  "sha256" text,
  "object_key" text,
  -- The thumbnail the upload made, when it could make one.
  "thumb_object_key" text,
  "width" integer,
  "height" integer,
  -- ready | blocked
  "status" text DEFAULT 'ready' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Bumped whenever the entry or (for folders) something directly inside it
  -- changes, so a share link's listing can say when its album last changed.
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "photo_entries_kind_check" CHECK ("kind" IN ('file', 'folder'))
);

CREATE UNIQUE INDEX "photo_entries_account_path_unique" ON "photo_entries" ("account_id", "path");

-- Share links: a token that reads one folder and everything below it. One per
-- folder; a move or rename rewrites `path` with the folder, a delete removes
-- the link with it. The token is shown to the owner again (the Photos page
-- lists links), so it is stored as is.
CREATE TABLE "photo_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "photo_shares_token_unique" ON "photo_shares" ("token");
CREATE UNIQUE INDEX "photo_shares_account_path_unique" ON "photo_shares" ("account_id", "path");

-- Every scan match (docs/photos.md "Scanning"). Evidence: the row outlives the
-- account (ON DELETE SET NULL) and keeps the email it had at the time.
CREATE TABLE "photo_scan_hits" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "account_email" text,
  "sha256" text NOT NULL,
  -- hash_list | photodna
  "scanner" text NOT NULL,
  -- The scanner's answer (PhotoDNA's tracking id and match details, the
  -- moderation categories), never the image.
  "details" jsonb,
  "client_ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "photo_scan_hits_created_idx" ON "photo_scan_hits" ("created_at");
-- The SET NULL above updates by this column.
CREATE INDEX "photo_scan_hits_account_idx" ON "photo_scan_hits" ("account_id") WHERE "account_id" IS NOT NULL;

-- SHA-256 digests no upload may have. Admins add rows.
CREATE TABLE "photo_blocked_hashes" (
  "sha256" text PRIMARY KEY NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Set when a scan matched: uploads are refused and every share link of the
-- account answers 404 until a superadmin clears it.
ALTER TABLE "accounts" ADD COLUMN "photos_suspended_at" timestamp with time zone;
