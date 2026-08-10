# Rehearsals

Run these before private beta and after auth/provider changes.

## First-Party Auth Rehearsal

Goal: prove every first-party auth flow works end to end.

1. Run `pnpm db:setup` and `pnpm dev` against a fresh database.
2. Sign up with email and password, sign out, and sign back in.
3. Request a password reset, follow the logged reset link on `/recovery`, and
   sign in with the new password.
4. With `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` configured, sign in with
   Google using an email that already has a password account and verify it
   attaches to the same account instead of creating a duplicate.
5. Grant one account the superadmin flag with `pnpm admin:grant <email>` and
   verify `/admin` lists, promotes, signs out, and deletes users.
6. Link a mock FrameOS backend through `/api/device/start` and `/device`.
7. Fetch `/api/backends/grants` with the linked backend token.

Pass criteria:

- Account IDs remain FrameOS-owned UUIDs.
- Provider subject changes are isolated to `account_identities`.
- Backend links, owner grants, and inventory remain in FrameOS Cloud DB.
- Only superadmin sessions can reach `/admin` and `/api/admin/*`.

## Revocation Propagation Rehearsal

Goal: prove connected backends converge after token changes.

1. Link a mock backend.
2. Fetch grants and confirm the owning account is present.
3. Revoke the linked backend from `/account`.
4. Confirm `/api/backends/grants` returns `invalid_link_token`.
5. Confirm `/api/backends/inventory` returns `invalid_link_token`.
6. Confirm `/api/frameos/login/start` returns `invalid_link_token`.
7. Reconnect the backend and verify a new token reference is issued.

Pass criteria:

- Grant responses identify only the linked backend owner.
- Revoked linked clients cannot sync inventory or fetch grants.
- Audit events exist for approval, inventory sync, and revocation.

## Local Postgres Rehearsal

Goal: prove a new developer machine can run the auth prototype.

1. Activate Flox.
2. Run `pnpm db:setup`.
3. Run `pnpm verify`.
4. Start `pnpm dev`.
5. Run `POST /api/device/start` against the local app.
6. Open `verification_uri_complete`.

Pass criteria:

- Postgres starts from `.flox/postgres`.
- Migrations apply once and are skipped on rerun.
- `.env.local` contains local database and generated dev secrets.
