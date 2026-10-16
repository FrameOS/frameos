# Photos

Photos is a library of albums that frames play. It is a top-level section of
the workspace (after Frames, Scenes and Apps), served by both control planes:
the self-hosted backend keeps the rows in SQLite and the bytes in a folder or
a bucket of its own, FrameOS Cloud keeps them in Postgres and R2. The SPA (`frontend/src/scenes/photos/`) talks to one HTTP contract,
described here, and the frame app `repo/apps/image/photoAlbum` reads an album
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
- A whole path is at most 1024 bytes and 32 segments deep. Moving or
  renaming a folder checks its contents against this too (400).
- Names are case sensitive.
- Names starting with `.` are never listed and cannot be created. On the
  backend, files a person copies into the folder by hand (`.DS_Store`) stay
  invisible.
- Names ending in `.frameos.json` are kept for color profiles (see Colors):
  they cannot be uploaded, created or renamed to.

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
  "status": "ready",
  "colors": { "whites": -30, "saturation": 20 }
}
```

- `kind` is `"file"` or `"folder"`.
- `mtime` is in seconds.
- `width`, `height`: pixels when known, else `null`, read from the image
  header on both planes.
- `status`: `"ready"`, or `"blocked"` on the cloud when a scan matched (the
  bytes are gone; see Scanning).
- `colors`: files only. The photo's color profile, or `null` (see Colors).
- Folders also carry `items` (direct children), `files` (files anywhere below)
  and `cover` (the path of an image to show for the folder, or `null`: the
  first image among the direct children by name, else the first one found in
  the subfolders by name, however deep). A folder's `size` is the total size
  of the files below it.

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
  "max_upload_bytes": 262144000,
  "accepts": null,
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
  when a scan matched, 503 when a scanner could not answer. The cloud also
  answers 429 `too_many_uploads` (16 unfinished uploads per account) and 507
  `entry_limit_reached`.

### `GET /api/photos/thumb?path=<file>`

A JPEG thumbnail, at most 512 px on the long side, turned by the photo's
EXIF orientation, transparency on white, or 404 when the server could not
read the image (the SPA then shows the file itself). Each plane makes its
own when the upload stores the photo, whoever uploaded it: the backend with
Pillow, the cloud with sharp. A JPEG gets one up to 400 megapixels (both
decoders shrink it while reading); a PNG, GIF, WebP or BMP decodes whole, so
those stop at 80 megapixels. The cloud's PhotoDNA scan copy follows the same
caps, so a larger image is refused where PhotoDNA is on.

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
`deleted` counts the outermost paths: a path inside another one listed is
gone with it, not counted. `paths` (here and for a move) is 1 to 10000
paths; an empty list is a 400.

### `POST /api/photos/colors`

`{"path": "Summer 2026/a.jpg", "colors": {"whites": -30}}` →
`{"entry": Entry}`. Sets the photo's color profile (see Colors).
`"colors": null`, or an empty object, removes it.

- `path` must be a playable image (400 otherwise, a folder included; 404
  when it is missing).
- `colors` must be present, a JSON object or `null` (400 otherwise), of at most 64 KB as JSON
  (413 otherwise). It is stored as sent: the keys are the editor's business,
  and the runtime clamps every value and ignores keys it does not know.
- Moving or renaming the photo keeps its profile; deleting it deletes the
  profile.

### `POST /api/photos/resize`

`{"path": "Summer 2026/a.jpg", "width": 1600, "height": 1200, "fit": "inside", "format": "keep", "quality": 85, "upscale": false, "background": "#ffffff", "colors": null}`
→ `{"entry": Entry}`. Replaces the photo with itself resized: new bytes, a
new thumbnail, a new `size`, `width` and `height`; the same entry otherwise
(its `colors`, its `mtime`, the share links of its folder). The result is
stored upright (the EXIF turn applied, then dropped).

- `path` must be a playable image (400 otherwise, a folder included; 404
  when it is missing).
- `width`, `height`: whole numbers from 1 to 16384. Give one or both.
- `fit`: `inside` (default; keeps the aspect, fits within the box, one side
  may be left out), `cover` (fills the box, crops the middle), `contain`
  (fits within the box, pads with `background`) or `fill` (stretches to
  the box). Every fit but `inside` needs both sides.
- `upscale` (default false): nothing is invented. `inside` never grows the
  photo; for the other fits a box larger than the photo shrinks to fit
  inside it at the box's own aspect. With `true` the box is taken as is.
- `format`: `keep` (default; the type the photo has) or `jpeg`, `png`,
  `webp`. A different type changes the extension, to a free name (`a.jpg`
  resized to PNG is `a.png`, or `a (2).png`); the returned entry has the
  path. A GIF or BMP kept keeps its type; a type the server cannot write is
  a 400.
- `quality`: 1 to 100, default 85, for JPEG and WebP (100 makes WebP
  lossless). A JPEG is always baseline, never progressive: that is what the
  smallest frames decode.
- `colors`: PNG only, 2 to 256: the result is reduced to a palette of that
  many colors. Absent: every color is kept.
- `background`: `#rrggbb`, default white: what `contain` pads with and what
  transparency is flattened on for JPEG and BMP.
- 413 for a photo over the thumbnailer's pixel cap, 503 when the server has
  no image library. The cloud scans the new bytes like an upload (422, 503).

### Share links

A folder has one link for anyone (`frame_id` and `name` null), one per
frame it plays on (`frame_id` the frame's id; "Install on frame" and
`POST /api/photos/scene` make it) and any number of custom links (`name`
what the owner called it, "Grandma"), so one link's access can be withdrawn
without touching the others. `last_used_at` is when something last read
through the link (moved at most once a minute), or null.

- `GET /api/photos/shares` → `{"shares": [Share, ...]}`, by folder, the
  general link before the frames' own.
- `POST /api/photos/shares` with `{"path": "Summer 2026"}` →
  `{"share": Share}`: the folder's general link, returned as it is when it
  exists. With `"frame_id"` the link for that frame, likewise. With
  `"name"` (1 to 120 characters, trimmed) a new custom link every time. The
  path must be an existing folder, not the root: 400 for the root or a
  file, 404 when nothing is there; a `frame_id` that is not one of the
  account's frames is a 404, one of the wrong shape a 400, as is a bad
  `name`.
- `DELETE /api/photos/shares/{token}` → `{"deleted": true}`. The other
  links of the folder keep working.

```json
{
  "token": "pk_3n1...",
  "path": "Summer 2026",
  "frame_id": null,
  "name": null,
  "url": "https://cloud.frameos.net/api/photos/shared/pk_3n1...",
  "created_at": 1760000000,
  "last_used_at": null
}
```

A deleted frame leaves its link behind, unbound on the cloud (the column
is a foreign key that nulls) and still naming the id on the backend, for
the dialog to show and the owner to remove.

`url` is absolute on the cloud. The backend does not know which address its
frames use to reach it, so it returns `/api/photos/shared/<token>` and the
SPA puts the frame's `server_scheme://server_host:server_port` in front.

Tokens are `pk_` plus at least 32 URL-safe random characters.

### `POST /api/photos/scene`

```json
{"path": "Summer 2026", "seconds": 3600, "order": "random", "fit": "cover", "shapes": ["landscape", "square"], "name": "Summer", "frame_id": 4}
```

→ `{"scene": Scene, "share": Share}`: a ready scene that plays the folder
(see Installing photo scenes), with the frame's own share link to the
folder in it, made now when the frame has none, as `POST /api/photos/shares`
with `frame_id` would. The backend requires `frame_id` (the link carries
the address that frame reaches the backend at); the cloud's links are
absolute, so without one the folder's general link serves. Installing the
scene is up to the caller (the frame routes, or the MCP's
`photo_album_install`).

- `path`: an existing folder, not the root (400 for the root or a file, 404
  when nothing is there).
- `seconds`: how long each photo stays, a positive number, default 3600.
- `order`: `random` (default), `sequential`, `newest` or `oldest`.
- `fit`: `cover` (default) or `contain`.
- `shapes`: which photos the scene plays, by shape: a non-empty list of
  distinct names from `landscape`, `portrait` and `square` (the scene's
  three boolean fields, see Installing photo scenes); default all three.
- `name`: the scene's name, at most 256 characters; default the folder's
  name.
- The SPA's builder also makes a single-photo scene (`photo`: the file's
  path relative to the folder, in the app node's config): the app asks for
  that photo by `path` instead of moving a counter, and the scene keeps only
  the `fit` field, with no counter, order or interval of its own.
- `frame_id`: backend only, and required there: the link in the scene is the
  address that frame uses to reach the backend (its `server_scheme`,
  `server_host` and `server_port`), so 404 for a frame of another project and
  400 for a frame without a server host. The cloud's links are absolute and
  it ignores the key.
- A bad option is a 400, checked before anything is shared.

## Share routes (what frames call)

No login: the token is the credential. Self-hosted these are not project
scoped and live on the public router, the one Home Assistant exposes on port
8989. They are rate limited per address: 3600 requests an hour, which is the
app's two requests per render at its fastest (5 s) for a couple of frames
behind one address. A deleted link, a deleted folder or a suspended account
is a 404.

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
      "content_type": "image/jpeg",
      "colors": null
    }
  ]
}
```

Every playable file below the shared folder, by path (natural order, one
segment at a time, as the owner's listing), at most 10000. `path` is
relative to the shared folder. `colors` is the photo's color profile or
`null`, as in an Entry.

### `GET /api/photos/shared/{token}/photo?order=<order>&index=<n>[&shapes=<shapes>]`

One photo, so a frame never downloads the whole listing. With
`?path=<path>` (relative to the shared folder) it is that photo, as
`{"index": 0, "count": 1, "photo": ...}`, or a 404 when nothing playable
is there: a scene that shows one photo (the Photos page's "Show on frame"
on a file) asks for it this way, and `order` and `index` are ignored.
Otherwise:

```json
{"index": 41, "count": 120, "photo": {"path": "...", "name": "...", "url": "...", "colors": null, "...": "..."}}
```

- `order`: `random` (default), `sequential` (by path), `newest`, `oldest` (by
  `mtime`, then path).
- `index` is a counter the frame keeps (default 0). The photo is the one at
  `index mod count` in that order. For `random` the order is a shuffle seeded
  by the token and `floor(index / count)`, so every photo shows once before
  any repeats and the next cycle has a new order. The two planes do not need
  to shuffle identically.
- `shapes`: a comma-separated list of `landscape`, `portrait` and `square`
  (a photo's shape is by its pixels: wider than tall, taller than wide, or
  exactly as wide as tall); only photos of those shapes count, and `count`
  is their number. Empty, absent or all three means every photo, a photo
  of unknown size included; with a choice a photo of unknown size never
  shows. A name that is not a shape is a 400.
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

The rows are the cloud's tables in SQLite: `photo_entry` (one row per file
and per folder, with the path, size, content type, SHA-256, object keys,
width and height, `colors` and timestamps) and `photo_share`. The bytes live
in an object store under their content hash, `photos/<sha256>`, with the
thumbnail (made at upload) under `photos/thumbs/<sha256>`: two uploads of one
photo share one object, and a row never holds a file name the disk has to
agree with. The store is one of:

- **A directory** (the default): `<photos dir>/objects`. The photos dir is
  the first of `FRAMEOS_PHOTOS_DIR`, `/data/photos` on a Home Assistant
  add-on, `photos/` next to the SQLite database (`/app/db/photos` in
  Docker). Unfinished uploads wait in `<photos dir>/.cache` whichever store
  is in use.
- **An S3-compatible bucket** (Cloudflare R2, AWS S3, MinIO, ...), when
  `FRAMEOS_PHOTOS_S3_ENDPOINT` (the service address, such as
  `https://<account>.r2.cloudflarestorage.com`), `FRAMEOS_PHOTOS_S3_BUCKET`,
  `FRAMEOS_PHOTOS_S3_ACCESS_KEY_ID` and `FRAMEOS_PHOTOS_S3_SECRET_ACCESS_KEY`
  are all set in the environment. `FRAMEOS_PHOTOS_S3_REGION` (default
  `auto`, what R2 takes; AWS needs the bucket's region) and
  `FRAMEOS_PHOTOS_S3_PREFIX` (a folder in the bucket) are optional. Requests
  are path style and signed with AWS Signature Version 4. The bucket stays
  private: frames and browsers get the bytes through the backend. Use one
  backend per bucket (or per prefix): deleting a photo deletes its object
  once no row of that backend points at it.

`location` in the status is the directory or `s3://<bucket>/<prefix> at
<host>`. The library is not ready (and the page says why) when:

- the directory cannot be created or written (`not_writable`);
- the backend runs in Docker and the directory is not on a mounted volume,
  which would lose every photo when the container is recreated
  (`not_persistent`; `FRAMEOS_PHOTOS_ALLOW_EPHEMERAL=1` skips the check);
- some of the four bucket variables are set and not all
  (`storage_misconfigured`), or the bucket refuses the keys or does not
  answer (`storage_unavailable`).

There is no quota; `free_bytes` is the free space on the disk, `null` for a
bucket. Uploads are at most 250 MiB each. Any file type can be stored; the
content type comes from the name.

### Cloud

Metadata is in Postgres (`photo_entries`, `photo_shares`), bytes in R2 under
`photos/<account id>/<random id>`. The keys are random rather than content
addressed: the CDN alias serves any key without authentication, and a content
hash is a key anyone who has the same photo could compute. Moving or renaming
only rewrites rows. A photo's color profile is the `colors` column (jsonb) of
its row.

Uploads accept JPEG, PNG, GIF and WebP only (every byte stored must pass the
scan), at most 250 MiB each. Each account has `FRAMEOS_CLOUD_MAX_PHOTO_MB` of
storage (default 1024) once its email is verified (a social login counts),
and the smaller `FRAMEOS_CLOUD_MAX_UNVERIFIED_PHOTO_MB` (default 250) until
then; at most 100 000 entries and 16 unfinished uploads.
Unfinished uploads wait on the app server's disk (`FRAMEOS_PHOTO_UPLOAD_DIR`),
never in the bucket, and a finished one is hashed, scanned, thumbnailed and
streamed to the bucket from that file, never held whole in memory.

Revoking a link stops new listings and redirects at once. A frame that already
holds a CDN address keeps it working until the photo is deleted.

## Colors

A photo may have a color profile: the same adjustments a frame asset's
`.frameos.json` sidecar holds (`docs/asset-color-profiles.md`: exposure,
whites and blacks, contrast, tones, saturation, hue ranges and an optional
dither palette), as its `colors` object. The Photos page edits it with the
Assets panel's **Set colors** editor and previews it either at full fidelity
or as a chosen panel shows it: scaled to the panel, with the frame's
automatic fit and fine tuning, dithered to its palette.

Frames get it with the photo. The share routes send `colors` with every file,
and `repo/apps/image/photoAlbum` hands it to the runtime as
`frameos.fetchImage(url, {colors})`, which grades the photo the way a local
asset's sidecar is applied, palette override included, so the frame's
automatic fit leaves it alone. A runtime older than 2026.10.13 ignores the
option and shows the photo ungraded, with the automatic fit as before.

## Scanning (cloud)

Every upload is scanned before anything is stored, by every scanner that is
configured (the thumbnail is made from the scanned bytes):

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
drawer) makes one scene per ticked album on one frame: it creates the frame's
own share link to the album, builds a scene around `repo/apps/image/photoAlbum`
with the link in the app node's config, and installs it like any other scene
(the frame's scenes list; the deploy follows). Settings: how long each photo stays, the
order, how a photo fits the screen, and which shapes of photo play. The
drawer also takes an album link from elsewhere (another FrameOS backend or the
cloud) to play as is, and makes a new album on the spot.

The scene: a `render` event into `render/image`, whose image comes from the
photoAlbum app node (`album` and `counterStateKey: "photoIndex"` in its
config, the app's config and sources in the scene's `apps.photoAlbum`), then
`logic/nextSleepDuration`. Its fields are `seconds` (the refresh interval),
`order` and `fit` (public, saved to disk, wired into the app and the
placement), `landscape`, `portrait` and `square` (public booleans, saved to
disk, wired into the app: which photo shapes it asks for, every one by
default) and `photoIndex` (private, saved to disk: the frame's place in the
album). Three builders make it: the SPA's (no round trip), the backend's and
the cloud's (both behind `POST /api/photos/scene`).
`docs/photo-album-scene.json` holds the scene they must all build; the SPA's
and the cloud's tests (`shared-spa/photos.test.ts`) and the backend's
(`test_photos.py`) compare with it.

## MCP

Both MCP servers (`docs/mcp.md`, `cloud/docs/mcp.md`) have the same photos
tools: `photos_status`, `photos_list`, `photo_get` (the thumbnail, or the
file with `original`), `photo_upload` (base64 or a URL the server downloads,
sent in the upload route's chunks), `photo_folder_create`, `photos_move`,
`photo_rename`, `photos_delete`, `photo_colors_set`, `photo_shares_list`,
`photo_share_create` (with `frame_id` one frame's own link, with `name` a
new custom link),
`photo_share_delete` and `photo_album_install` (`POST /api/photos/scene`,
then the frame's own install). Every write takes
`confirm: true`, because a frame playing a shared album shows the change on
its next photo, and sharing makes a folder readable by anyone with the link.
