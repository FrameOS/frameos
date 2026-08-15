# Backups

Everything a restore needs lives in two places: the Postgres database (all
user data — accounts, sessions, frames, scenes, scene-store bytes, and
uploaded asset contents are all rows, including the `bytea` blobs) and a
small set of host files that are in neither the repo nor the database (env
secrets, nginx config, the systemd units, `frameos-cloud-update`,
letsencrypt state). The application itself is not backed up: any pushed ref
can be rebuilt and redeployed with `pnpm deploy:prod`
([deployment.md](deployment.md)).

Two independent layers ship to the Hetzner Storage Box
(`u651211.your-storagebox.de`, SFTP port 23, SSH-key auth):

1. **pgBackRest — continuous ("live") backups, point-in-time recovery.**
   Postgres archives every WAL segment to the Storage Box as it is produced
   (at most 5 minutes behind, per `archive_timeout`), on top of weekly full
   and daily differential base backups. Recovery point: minutes; recovery
   window: ~4 weeks (`repo1-retention-full=4`). Repo config:
   `/etc/pgbackrest/pgbackrest.conf`, stanza `frameos`, repo path
   `/home/pgbackrest` on the box. Timers:
   `frameos-cloud-pgbackrest-full.timer` (Sun 02:47 UTC) and
   `frameos-cloud-pgbackrest-diff.timer` (Mon–Sat 02:47 UTC), both running
   as `postgres`.
2. **Nightly logical dump + host config** — `frameos-cloud-backup.timer`
   (04:17 UTC) runs `/usr/local/bin/frameos-cloud-backup` (source:
   `cloud/ops/backup/pg-backup.sh`): a `pg_dump` custom-format dump
   (verified with `pg_restore --list` before upload) plus a tarball of
   everything on the host that is in neither the repo nor the database
   (2026-08 audit): `/etc/frameos-cloud`, nginx, letsencrypt, postgres,
   pgbackrest and ufw config, the systemd units, all of `/usr/local/bin`,
   `/root` ops scripts and logs, the rclone/SSH backup credentials, the
   release stamps, and a generated rebuild manifest (installed packages,
   enabled units, tool versions). Shipped with rclone to
   `storagebox:frameos-cloud-backups` and pruned after 30 days. The logical
   dump is deliberately redundant with pgBackRest: it survives a pgBackRest
   repo bug, restores across Postgres major versions, and makes
   single-table recovery easy. It supersedes the older local-only
   `frameos-cloud-db-backup.timer` (disabled, script left in place).

Not provided, deliberately: high availability. A dead box means downtime
until a rebuild ("Restore" below), not a failover — the correct trade at
this scale.

The kit lives in `cloud/ops/backup/` (`pg-backup.sh`, the two
`frameos-cloud-backup` units, `backup.env.example`, `rclone.conf.example`,
`install.sh` — idempotent, honours `FRAMEOS_CLOUD_DEPLOY_HOST` /
`FRAMEOS_CLOUD_DEPLOY_SSH_KEY`). The pgBackRest side is configured directly
on the host (this file is its runbook).

## Credentials and access

- Private key: `/root/.ssh/hetzner-storage.key` (rclone, manual SFTP) and a
  postgres-owned copy at `/var/lib/postgresql/.ssh/hetzner-storage.key`
  (pgBackRest `archive-push`/`backup` run as `postgres`). Local original:
  `~/.ssh/hetzner-storage.key` on the laptop.
- The key's public half must be registered on the Storage Box (Hetzner
  console → Storage Box → SSH keys). Host keys are pinned in each user's
  `known_hosts` (`ssh-keyscan -p 23`).
- `HEALTHCHECKS_URL` in `/etc/frameos-cloud/backup.env` pings a
  healthchecks.io check on every nightly run (start/success/fail); create
  the check with period 1 day, grace 6 hours. Silence becomes an email.

## Watching it

```sh
ssh <host> pgbackrest --stanza=frameos info          # base backups + WAL coverage
ssh <host> systemctl list-timers 'frameos-cloud-*' --no-pager
ssh <host> journalctl -u frameos-cloud-backup -n 50
ssh <host> rclone lsl storagebox:frameos-cloud-backups
```

`pgbackrest info` is the health check that matters for the live layer: the
newest backup's WAL "max" keeps advancing as segments archive.

Storage Box capacity: `rclone about storagebox:` (1 TiB box). The nightly
job also appends `box_used`/`box_free` to every success ping — the
healthchecks.io log doubles as a capacity history — and fails the run
(which alerts) if free space drops below 50 GiB. Growth is bounded by
retention on both layers, so steady state is a few GiB. A manual
extra dump before risky migrations: `frameos-cloud-backup`; a manual base
backup: `sudo -u postgres pgbackrest --stanza=frameos --type=diff backup`.

## Restore

### Point in time (bad deploy, bad migration, fat-fingered DELETE)

pgBackRest restores the whole cluster to any moment inside the retention
window — e.g. one minute before the bad statement:

```sh
systemctl stop frameos-cloud-auth-web.service frameos-cloud-frame-hub.service
systemctl stop postgresql
sudo -u postgres pgbackrest --stanza=frameos --delta \
  --type=time --target="2026-08-15 09:00:00+00" --target-action=promote restore
systemctl start postgresql
# verify, then:
systemctl start frameos-cloud-auth-web.service frameos-cloud-frame-hub.service
```

`--delta` reuses unchanged files in the data directory, so this is fast.
Omit `--type=time --target=...` to restore to the latest archived WAL
(minutes before a crash). Connected frames reconnect on their own.

### From the nightly logical dump

```sh
systemctl stop frameos-cloud-auth-web.service frameos-cloud-frame-hub.service
rclone copy storagebox:frameos-cloud-backups/db-<stamp>.dump /root/restore/
pg_restore --clean --if-exists --no-owner \
  -d "$DATABASE_URL" /root/restore/db-<stamp>.dump
systemctl start frameos-cloud-auth-web.service frameos-cloud-frame-hub.service
```

For a single table, restore into a scratch database (see "Rehearsal") and
copy rows across with `psql` — a full `--clean` restore for one table
throws away everything newer in every other table.

### Whole box (host dead or unreachable)

1. Provision a fresh server ([deployment.md](deployment.md) — same OS,
   Node 22, Postgres, nginx) and put the Storage Box key on it.
2. Fetch the newest `host-<stamp>.tar.gz` from
   `storagebox:frameos-cloud-backups` and unpack at `/`: restores all env
   secrets, nginx/postgres/pgbackrest/ufw config, letsencrypt state, the
   systemd units, `/usr/local/bin` scripts, and the backup credentials.
   Its `var/backups/frameos-cloud/manifest.txt` lists the packages and
   enabled units the old box had — the checklist for step 1.
3. Restore the database: install pgbackrest, copy
   `/etc/pgbackrest/pgbackrest.conf` from the host tarball's era or this
   doc, then `pgbackrest --stanza=frameos restore` into an empty data
   directory (or use the newest nightly dump as above if you prefer
   logical).
4. Point `FRAMEOS_CLOUD_DEPLOY_HOST` at the new box and `pnpm deploy:prod`.
5. Move DNS. Re-enable the backup timers so the new box backs itself up.

## Rehearsal

An untested backup is a hypothesis. Quarterly, restore last night's dump
into a scratch database (safe on the prod box; touches nothing live):

```sh
sudo -u postgres createdb frameos_cloud_restore_test
pg_restore --no-owner -d "postgres://frameos_cloud:...@localhost:5432/frameos_cloud_restore_test" \
  /var/backups/frameos-cloud/db-<newest>.dump
psql "postgres://.../frameos_cloud_restore_test" -c \
  "SELECT (SELECT count(*) FROM accounts) AS accounts,
          (SELECT count(*) FROM frames) AS frames,
          (SELECT max(applied_at) FROM schema_migrations) AS last_migration;"
sudo -u postgres dropdb frameos_cloud_restore_test
```

Rehearse the pgBackRest path and the whole-box path once each against a
throwaway Hetzner instance before trusting them.

## Security notes

- Backups contain everything: password hashes, session rows, encrypted
  linked-client credentials; the host tarball contains `SESSION_SECRET`,
  `FRAMEOS_CLOUD_ENCRYPTION_KEY`, and TLS keys. **The Storage Box key is a
  production secret**, and rotating keys per
  [operational-runbooks.md](operational-runbooks.md) does not retire the
  copies inside retained backups.
- Everything is chmod 600/700 on-box and transported over SSH.
- Optional hardening: wrap the rclone remote in an `rclone crypt` layer
  and/or pgBackRest `repo1-cipher-type=aes-256-cbc` (client-side
  encryption; the passphrase then becomes a secret you must keep OUTSIDE
  the backups), or restrict the Storage Box to Hetzner-internal access.
