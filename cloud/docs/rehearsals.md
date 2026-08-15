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

## Restore Rehearsal

Goal: prove the backups are a backup and not a hypothesis. Quarterly, and
after any schema change or change to the backup job.

Procedure, findings from the first run (2026-08-15, both paths passed), and
the two gotchas it uncovered are in [backups.md](backups.md#rehearsal). The
short version:

1. On a machine that is not the prod box, run
   `sudo -u postgres ops/backup/restore-drill.sh --sftp --sftp-key <key>`.
2. Read the row counts and blob sizes it prints; the script asserts the
   obvious failure modes itself and exits non-zero on them.
3. Once a year, also walk the whole-box path (host tarball + pgBackRest)
   against a throwaway instance, since the drill script only covers the
   logical dump.

Pass criteria:

- `restore-drill.sh` exits 0, with `pg_restore` reporting no errors.
- Row counts and the migration count match production's order of magnitude.
- Blob tables sum to non-zero bytes (a truncated `bytea` restores as a row
  with no content, which row counts alone would wave through).
- For the whole-box path: `pg_is_in_recovery()` returns false before any
  numbers are believed, and the recovery point is within the ≤5 min RPO.

## Deploy Rehearsal

Goal: prove a deploy cannot take the site down, and that a bad one is a
failed deploy rather than an outage. Before changing anything in
`ops/deploy/`, and before the one-time install on a host.

```sh
cloud/ops/deploy/rehearse.sh   # needs docker; nothing else
```

It runs the real `frameos-cloud-update` and `install.sh` inside a Debian
container against a fake host — stub `systemctl`, `nginx`, `curl` and `psql`,
a throwaway `/opt` tree — and asserts the orchestration end to end.

Pass criteria (the script checks each and exits non-zero on any):

- A deploy starts the new release on the **idle** port and only moves nginx
  after `/healthz` answers there; consecutive deploys alternate ports.
- A release that never becomes healthy, a failing migration, and an `nginx
-t` failure each leave the upstream and the live release untouched.
- `--rollback` returns to the previous release the same way.
- The frame hub is restarted when its bundle changed and left running when it
  did not, so a merge that does not touch `apps/frame-hub` costs the fleet no
  reconnects.
- A second deploy arriving while one is running is refused rather than
  interleaved, and succeeds once the lock is free.
- The deploy key's forced command (`frameos-cloud-deploy-command`) allows the
  four deploy commands and refuses a shell, a chained command, a prefix match
  and reading the environment file.
- `install.sh` converts a legacy host without moving traffic until the new
  instance is up, keeps a backup of every vhost it rewrites, and leaves the
  frame hub's own `proxy_pass` alone.
- Exactly one auth-web instance is left running afterwards, pinned to the
  live release.

What it cannot prove, and what still has to be watched on the box: real unit
semantics (`Restart=`, ordering, `ProtectSystem=strict`), and that Next.js
actually boots on the idle port. `pnpm deploy:prod` covers the second one by
polling the live site throughout the deploy and printing any non-2xx.

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
