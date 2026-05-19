# TODO: FrameOS Cloud Authentication and Encrypted Backups

This backend work integrates the self-hosted FrameOS backend with FrameOS Cloud while keeping backup plaintext out of FrameOS Cloud.

## First-user signup mode

Add a signup option named **Authenticate via FrameOS Cloud**.

This option is only available when the self-hosted backend has no local user yet. If a user already exists, hide or disable the cloud-auth signup option and require the existing local login flow.

When selected:

1. Generate and store a CSRF `state` for the signup session.
2. Redirect the browser to FrameOS Cloud:

   ```text
   GET https://frameos.net/api/cloud/backend/auth/start
     ?redirect_uri=<this-backend>/api/cloud/callback
     &state=<csrf-state>
     &backend_name=<display-name>
     &backend_url=<backend-origin>
   ```

3. FrameOS Cloud signs in the user if needed, then redirects back:

   ```text
   <this-backend>/api/cloud/callback?code=<one-time-code>&state=<csrf-state>
   ```

4. Verify `state`, then exchange the code server-side:

   ```http
   POST https://frameos.net/api/cloud/backend/auth/exchange
   Content-Type: application/json

   {
     "code": "<one-time-code>",
     "backendName": "Kitchen backend",
     "backendUrl": "http://frameos.local:8989"
   }
   ```

5. Store the returned `backendToken` encrypted or otherwise protected in the local backend database.
6. Create the first local user record from the returned cloud user email.
7. Mark the local user as `cloud_auth_required=true` and `cloud_user_id=<FrameOS Cloud user id>`.

## Login contract

When the first user signed up through FrameOS Cloud, local login is a two-factor flow:

- local backend credentials or local session are still required
- FrameOS Cloud login is also required
- only the first local user can be bound to FrameOS Cloud in this mode
- if the cloud check fails, reject login even when the local password is correct

Implementation options:

- redirect browser login through FrameOS Cloud and validate a returned one-time code before issuing the local session cookie
- or require a valid local session first, then complete cloud login before enabling authenticated API access

Do not allow additional local users to bind their own cloud accounts until multi-user backend support exists.

## Backup export contract

Add backend export endpoints that prepare plaintext only for the browser or local backend, never for FrameOS Cloud.

The export should include:

- backend database metadata: frames, scenes, settings, schedules, device config, access keys, deploy state, custom backend assets, and restore compatibility metadata
- frame-local state from `/srv/frameos/state`
- frame-local assets from `/srv/assets`
- copied fonts and other generated files referenced by scenes
- FrameOS backend version and frame runtime versions

Skip transient logs and build output by default. Offer them as optional encrypted objects later.

Suggested local endpoints:

```text
GET /api/cloud/export/manifest
GET /api/cloud/export/objects/:objectId
POST /api/cloud/import/prepare
POST /api/cloud/import/objects/:objectId
POST /api/cloud/import/commit
```

The frontend should fetch plaintext export data from the local backend, encrypt it in the browser, and upload only encrypted envelopes to FrameOS Cloud.

## FrameOS Cloud backup API

Use the cloud token from signup for backend sync:

```http
Authorization: Bearer <backendToken>
```

Manifest routes:

```text
GET /api/cloud/backups
POST /api/cloud/backups
GET /api/cloud/backups/:id
DELETE /api/cloud/backups/:id
```

Encrypted object routes:

```text
PUT /api/cloud/backups/:id/objects/:objectId
GET /api/cloud/backups/:id/objects/:objectId
DELETE /api/cloud/backups/:id/objects/:objectId
```

`POST /api/cloud/backups` accepts only an encrypted manifest:

```json
{
  "backupId": "optional-stable-id",
  "encryptedManifest": {
    "version": 1,
    "algorithm": "AES-256-GCM",
    "kdf": "PBKDF2-SHA-256",
    "iterations": 250000,
    "encoding": "base64url",
    "salt": "...",
    "iv": "...",
    "ciphertext": "..."
  }
}
```

`PUT /api/cloud/backups/:id/objects/:objectId` accepts only encrypted object data:

```json
{
  "digest": "sha256:<ciphertext-digest>",
  "encryptedObject": {
    "version": 1,
    "algorithm": "AES-256-GCM",
    "encoding": "base64url",
    "iv": "...",
    "ciphertext": "..."
  }
}
```

Do not send frame names, asset paths, scene details, keys, or restore metadata as plaintext cloud fields. Store them inside the encrypted manifest or encrypted objects.

## Restore contract

Restore should be browser-mediated:

1. Browser downloads encrypted manifest and object index from FrameOS Cloud.
2. User enters backup passphrase locally.
3. Browser decrypts manifest locally.
4. Browser streams decrypted metadata and assets into the self-hosted backend import session.
5. Backend validates schema version, target device compatibility, and restore plan before commit.
6. Backend writes database records, frame state, assets, and schedules deploys where needed.

The cloud server must never receive passphrases, derived keys, plaintext manifests, plaintext assets, or decrypted frame metadata.
