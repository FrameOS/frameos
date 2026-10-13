# Photos

Photos is a library of albums that frames play. It is a top-level section of
the workspace (after Frames, Scenes and Apps), served by both control planes:
the self-hosted backend keeps the files on disk, FrameOS Cloud keeps them in
R2. The SPA (`frontend/src/scenes/photos/`) talks to one HTTP contract,
described here, and the frame app `repo/apps/code/photoAlbum` reads an album
through a share link.

## Words

- **Library**: everything one owner has. A backend project has one library; a
  cloud account has one library.
- **Album**: a folder at the top of the library. Albums are listed in the
  sidebar.
- **Folder**: any folder. Folders nest.
- **File**: anything stored in a folder. Frames only play images.
- **Share link**: a token that gives read access to one folder and
  everything below it. Scenes made with "Install photo scenes" carry a share
  link, so a frame never needs the owner's credentials. A link can be played
  by any frame, including someone else's.

## Paths

Every path is relative to the library root.

- `/` separates segments. No leading or trailing `/`. The root is `""`.
- A segment is 1 to 255 bytes of UTF-8. It is not `.` or `..`, does not start
  with `.`, and contains no `/`, `\`, NUL or control character (below 0x20,
  and 0x7f).
- A whole path is at most 1024 bytes and 32 segments deep.
- Names are case sensitive.
- Names starting with `.` are never listed and cannot be created. On the
  backend, files a person copies into the folder by hand (`.DS_Store`) stay
  invisible.

A path that breaks these rules is a 400.

## Entry

The shape every listing returns:

```json
{
  "path": "Summer 2026/beach.jpg",
  "name": "beach.jpg",
  "kind": "file",
  "size": 2483021,
  "mtime": 1760000000,
  "content_type": "image/jpeg",
  "width": 4032,
  "height": 3024,
  "status": "ready"
}
```

- `kind` is `"file"` or `"folder"`.
- `mtime` is in seconds.
- `width`, `height`: pixels when known, else `null`. The backend reads them
  from the image header; the cloud stores what the browser measured.
- `status`: `"ready"`, or `"blocked"` on the cloud when a scan matched (the
  bytes are gone; see Scanning).
- Folders also carry `items` (direct children), `files` (files anywhere below)
  and `cover` (the path of an image to show for the folder, or `null`: the
  first image among the direct children by name, else the first one a level
  down). A folder's `size` is the total size of the files below it.

## Owner routes

Self-hosted these are project scoped on the wire
(`/api/projects/{id}/photos/...`; `apiFetch` adds it). On the cloud they are
account scoped by the session or an API token. Mutations need the usual CSRF
origin check on the cloud.

Errors use each plane's usual body (`{"detail": ...}` on the backend,
`{"error": ...}` on the cloud); the status codes below are shared.

### `GET /api/photos/status`

```json
{
  "ready": true,
  "problem": null,
  "message": null,
  "location": "/app/db/photos/project_1",
  "used_bytes": 123456,
  "quota_bytes": 1073741824,
  "free_bytes": 9876543210,
  "max_upload_bytes": 67108864,
  "accepts": null,
  "client_thumbnails": false,
  "scanning": []
}
```

- `ready: false` blocks the page: the SPA shows `message` and nothing else.
  `problem` is one of `"not_writable"`, `"not_persistent"`,
  `"storage_unavailable"`, `"suspended"`. Every other owner route answers 503
  while the library is not ready.
- `location`: where the files live (backend only, `null` on the cloud).
- `quota_bytes`, `free_bytes`: `null` when there is no such limit.
- `accepts`: the content types uploads may have, or `null` for any file.
- `client_thumbnails`: `true` when the browser should make a thumbnail after
  each upload and send it to `POST /api/photos/thumb` (the cloud has no image
  library on the server). The backend makes its own.
- `scanning`: the scanners every upload passes (cloud), e.g.
  `["hash_list", "photodna"]`.

### `GET /api/photos/files?path=<folder>`

`{"path": "<folder>", "entries": [Entry, ...]}`: the direct children of one
folder, folders first, then by name (case insensitive, numbers in natural
order). 404 when the folder does not exist.

### `POST /api/photos/upload`

One file, in chunks, the protocol the frame asset routes use:

```
POST /api/photos/upload?path=<folder>&filename=<name>&upload_id=<id>&offset=<n>&complete=0|1
Content-Type: application/octet-stream

<bytes>
```

- `upload_id`: 8 to 64 characters of `[A-Za-z0-9_-]`, chosen by the client.
- Each chunk is written at `offset`. A chunk that does not start where the
  previous one ended answers 409 (the server lost earlier bytes) and the
  client restarts with a new id. Chunks are at most 4 MiB.
- An unfinished upload answers `{"pending": true, "received": <bytes>}`. The
  last chunk (`complete=1`) answers `{"entry": Entry}`.
- Missing parent folders are created.
- When `<folder>/<filename>` exists the file is stored as `name (2).jpg`,
  `name (3).jpg`, and so on. The returned entry has the real path.
- Unfinished uploads are dropped after an hour.
- 413 over `max_upload_bytes`, 415 when `accepts` does not list the type
  (sniffed from the bytes, not the name), 507 when the quota is used up, 422
  when a scan matched.

### `POST /api/photos/thumb?path=<file>`

Raw JPEG body, at most 512 KiB, at most 512 px on the long side. Stored as
that file's thumbnail when `client_thumbnails` is true; the backend answers
204 and ignores it.

### `GET /api/photos/thumb?path=<file>`

A thumbnail, at most 512 px on the long side, or 404 when there is none (the
SPA then shows the file itself). Browser previews only.

### `GET /api/photos/file?path=<file>[&download=1]`

The file's bytes, with inert headers (`nosniff`, a sandbox CSP, non-images as
attachments).

### `POST /api/photos/folders`

`{"path": "Summer 2026/Beach"}` → `{"entry": Entry}`. Parents are created.
409 when the path exists.

### `POST /api/photos/move`

`{"paths": ["a.jpg", "Summer 2026"], "to": "Albums/2026"}` →
`{"moved": [{"from": "a.jpg", "to": "Albums/2026/a.jpg"}, ...]}`

- `to` is a folder (`""` is the root) and must exist.
- A name that is taken at the destination gets the ` (2)` suffix.
- Moving a folder into itself or below itself is a 400. An item already in
  `to` is left where it is (`from` equals `to`).
- Every path is checked before anything moves: one missing path is a 404 and
  nothing changes.
- Share links follow the folders they point at.

### `POST /api/photos/rename`

`{"path": "Summer 2026/a.jpg", "name": "b.jpg"}` → `{"entry": Entry}`. 409
when the name is taken. Share links follow.

### `POST /api/photos/delete`

`{"paths": ["a.jpg", "Old album"]}` → `{"deleted": 2}`. Folders go with
everything in them, and so do the share links pointing at or below them.

### Share links

- `GET /api/photos/shares` → `{"shares": [Share, ...]}`
- `POST /api/photos/shares` with `{"path": "Summer 2026"}` →
  `{"share": Share}`. A folder has at most one link, so this returns the
  existing one if there is one. The path must be an existing folder, not the
  root.
- `DELETE /api/photos/shares/{token}` → `{"deleted": true}`.

```json
{
  "token": "pk_3n1...",
  "path": "Summer 2026",
  "url": "https://cloud.frameos.net/api/photos/shared/pk_3n1...",
  "created_at": 1760000000
}
```

`url` is absolute on the cloud. The backend does not know which address its
frames use to reach it, so it returns `/api/photos/shared/<token>` and the
SPA puts the frame's `server_scheme://server_host:server_port` in front.

Tokens are `pk_` plus at least 32 URL-safe random characters.

## Share routes (what frames call)

No login: the token is the credential. Self-hosted these are not project
scoped and live on the public router, the one Home Assistant exposes on port
8989. They are rate limited per address. A deleted link, a deleted folder or a
suspended account is a 404.

"Playable" means an image a frame can decode, by extension: `jpg`, `jpeg`,
`png`, `gif`, `bmp`, `webp`, `qoi`, `ppm`.

### `GET /api/photos/shared/{token}`

```json
{
  "name": "Summer 2026",
  "count": 2,
  "updated_at": 1760000000,
  "files": [
    {
      "path": "beach/a.jpg",
      "name": "a.jpg",
      "url": "/api/photos/shared/pk_3n1.../file?path=beach%2Fa.jpg",
      "size": 2483021,
      "mtime": 1760000000,
      "width": 4032,
      "height": 3024,
      "content_type": "image/jpeg"
    }
  ]
}
```

Every playable file below the shared folder, by path, at most 10000. `path`
is relative to the shared folder.

### `GET /api/photos/shared/{token}/photo?order=<order>&index=<n>`

One photo, so a frame never downloads the whole listing:

```json
{"index": 41, "count": 120, "photo": {"path": "...", "name": "...", "url": "...", "...": "..."}}
```

- `order`: `random` (default), `sequential` (by path), `newest`, `oldest` (by
  `mtime`, then path).
- `index` is a counter the frame keeps (default 0). The photo is the one at
  `index mod count` in that order. For `random` the order is a shuffle seeded
  by the token and `floor(index / count)`, so every photo shows once before
  any repeats and the next cycle has a new order. The two planes do not need
  to shuffle identically.
- An empty album answers `{"index": n, "count": 0, "photo": null}`.

### `GET /api/photos/shared/{token}/file?path=<path>`

The bytes of one playable file below the shared folder (`path` relative to
it). The backend streams them. The cloud answers 302 to the file's address on
the public CDN when one is configured, else streams them. Frame runtimes
follow up to 5 redirects.

A `url` that starts with `/` is relative to the share link's origin
(`scheme://host[:port]`).

## Storage

### Backend

Files live on disk, one folder per project:
`<photos dir>/project_<id>/<path>`. The photos dir is the first of:

1. `FRAMEOS_PHOTOS_DIR`
2. `/data/photos` on a Home Assistant add-on
3. `photos/` next to the SQLite database (`/app/db/photos` in Docker)

The folder is a plain folder: files copied into it by hand show up in the
library. Thumbnails and unfinished uploads live in `<photos dir>/.cache`.
Share links are rows in the `photo_share` table.

The library is not ready (and the page says why) when the folder cannot be
created or written, or when the backend runs in Docker and the folder is not
on a mounted volume, which would lose every photo when the container is
recreated. `FRAMEOS_PHOTOS_ALLOW_EPHEMERAL=1` skips that last check.

There is no quota; `free_bytes` is the free space on the disk. Uploads are at
most 64 MiB each.

### Cloud

Metadata is in Postgres (`photo_entries`, `photo_shares`), bytes in R2 under
`photos/<account id>/<random id>`. The keys are random rather than content
addressed: the CDN alias serves any key without authentication, and a content
hash is a key anyone who has the same photo could compute. Moving or renaming
only rewrites rows.

Uploads accept JPEG, PNG, GIF and WebP only (every byte stored must pass the
scan), at most 20 MiB each. Each account has `FRAMEOS_CLOUD_MAX_PHOTO_MB` of
storage (default 1024), at most 100 000 entries and 16 unfinished uploads.
Unfinished uploads wait on the app server's disk (`FRAMEOS_PHOTO_UPLOAD_DIR`),
never in the bucket.

Revoking a link stops new listings and redirects at once. A frame that already
holds a CDN address keeps it working until the photo is deleted.

## Scanning (cloud)

Every upload, and every thumbnail the browser sends, is scanned before
anything is stored, by every scanner that is configured:

1. **Hash list**: the SHA-256 against `photo_blocked_hashes`, always on.
   Admins add hashes.
2. **PhotoDNA**: Microsoft's hash matching against known abuse material, when
   `PHOTODNA_SUBSCRIPTION_KEY` is set (`PHOTODNA_ENDPOINT` overrides the
   Match URL). Written against the published Match API; try the first real
   key with a known-clean image before relying on it.

OpenAI moderation is not a scanner here: `omni-moderation` scores
`sexual/minors` on text only, so an image can never trip it.

A configured scanner that cannot be reached fails the upload (503) and
stores nothing. A match stores nothing, records a `photo_scan_hits` row (the
hash, the scanner and its answer, the account and the address), suspends the
account's photos (`accounts.photos_suspended_at`: uploads refused, every share
link 404) and notifies the admins. Reporting to NCMEC is a manual step from
the admin page.

Cloudflare's CSAM Scanning Tool can additionally be turned on for the CDN zone
that serves the bucket. It scans what the CDN serves, which includes every
photo a frame plays.

## Installing photo scenes

"Install photo scenes" (the Photos page, an album's menu and the "Add scene"
drawer) makes one scene per ticked album on one frame: it creates the album's
share link, builds a scene around `repo/apps/code/photoAlbum` with the link in
the app node's config, and installs it like any other scene (the frame's
scenes list; the deploy follows). Settings: how long each photo stays, the
order, and how a photo fits the screen.
