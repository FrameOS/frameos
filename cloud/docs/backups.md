# Backups

Everything a restore needs lives in three places now: the Postgres database
(all user data — accounts, sessions, frames, scenes, and the metadata of every
stored blob), the **object store** (the blob bytes themselves since migration
0032 — scene zips, previews, gallery images, cached frame snapshots), and a
small set of host files that are in neither the repo nor the database (env
secrets, nginx config, the systemd units, `frameos-cloud-update`,
letsencrypt state). The application itself is not backed up: any pushed ref
can be rebuilt and redeployed with `pnpm deploy:prod`
([deployment.md](deployment.md)).

**The database backup no longer carries the bytes.** A restore from Postgres
alone comes back with every scene, every version row and every `object_key`
intact, and no content behind them — pages render, downloads 404. That is a
change in what "restored" means, and it is why the object store needs its own
answer:

- **Blobs are immutable and content-addressed.** A key is the sha256 of its
  bytes, and nothing ever overwrites one with different content, so the store
  only ever grows within an account's quota. There is no point-in-time
  problem to solve, only a durability one.
- **The object store has its own nightly copy**, to the same Storage Box:
  `frameos-cloud-object-backup.timer` at 05:17 UTC, an hour after the database
  job so the object copy can only ever be newer than the rows referencing it.
  It **copies, never syncs** — a sync would mirror a deletion in R2 onto the
  backup, which is exactly the failure it exists for. Objects are immutable
  and named after the sha256 of their own content, so copy-only is also
  complete: the backup accumulates everything that ever existed, and rclone
  runs with `--immutable` so a key whose content ever changed fails the run
  instead of overwriting the good copy.
- **What is still missing** is a bucket-level versioning or lifecycle policy in
  Cloudflare. The off-box copy means a leaked R2 key can no longer destroy the
  only copy, but it can still empty the live bucket and take the site's images
  down until a restore. Keep the keys to the two services that need them.
- **No blob bytes remain in Postgres.** The `content` columns are empty
  everywhere; a database backup carries the rows, the keys and the recorded
  sizes, and none of the bytes.

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

The kit lives in `cloud/ops/backup/` (`pg-backup.sh`, `restore-drill.sh`,
the two `frameos-cloud-backup` units, `backup.env.example`,
`rclone.conf.example`, `install.sh` — idempotent, honours
`FRAMEOS_CLOUD_DEPLOY_HOST` / `FRAMEOS_CLOUD_DEPLOY_SSH_KEY`). The
pgBackRest side is configured directly on the host (this file is its
runbook).

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
systemctl stop 'frameos-cloud-auth-web@*.service' frameos-cloud-frame-hub.service
systemctl stop postgresql
sudo -u postgres pgbackrest --stanza=frameos --delta \
  --type=time --target="2026-08-15 09:00:00+00" --target-action=promote restore
systemctl start postgresql
# verify, then:
systemctl start "frameos-cloud-auth-web@$(cat /etc/frameos-cloud/active-port).service" frameos-cloud-frame-hub.service
```

auth-web runs as a port-named template instance and only one of the pair is
up, hence the glob to stop it and `/etc/frameos-cloud/active-port` to start
the right one again (`frameos-cloud-update --status` prints it too).

`--delta` reuses unchanged files in the data directory, so this is fast.
Omit `--type=time --target=...` to restore to the latest archived WAL
(minutes before a crash). Connected frames reconnect on their own.

### From the nightly logical dump

```sh
systemctl stop 'frameos-cloud-auth-web@*.service' frameos-cloud-frame-hub.service
rclone copy storagebox:frameos-cloud-backups/db-<stamp>.dump /root/restore/
pg_restore --clean --if-exists --no-owner \
  -d "$DATABASE_URL" /root/restore/db-<stamp>.dump
systemctl start "frameos-cloud-auth-web@$(cat /etc/frameos-cloud/active-port).service" frameos-cloud-frame-hub.service
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

An untested backup is a hypothesis. `ops/backup/restore-drill.sh` is the
test: it fetches the newest dump, restores it into a scratch database,
verifies the contents, and drops the scratch database again. It never
touches the live database, and its exit status is the result — 0 means the
backups are known-good, non-zero means someone has to look.

Quarterly, and after any change to the schema or the backup job:

```sh
# From a machine that is NOT the prod box — this also proves the backups are
# readable from somewhere other than the host that wrote them, which is the
# case that matters when the host is the thing that died.
sudo -u postgres ./restore-drill.sh --sftp --sftp-key ~/.ssh/hetzner-storage.key

# On the prod box (rclone config lives under root, postgres has no copy):
sudo -u postgres RCLONE_CONFIG=/root/.config/rclone/rclone.conf \
  /usr/local/bin/frameos-cloud-restore-drill
```

Row counts alone would pass on a dump whose `bytea` columns were truncated,
so the drill also sums `length(content)` over the blob tables — that forces
Postgres to read every byte back out of restored TOAST storage — and asserts
that an empty-but-valid restore fails rather than looking like a pass.

That sum is **zero** now — the blob bytes live in the object store. Keep the
check (it is what would catch a truncated dump if bytes ever came back), but
read it for what it is: a green drill no longer says anything about whether the
blobs are recoverable. That question belongs to the object store, and is not
yet rehearsed.

What a full recovery needs today, in order: restore Postgres (either path
above), then restore the objects the rows point at — from R2 if it still has
them, otherwise from `storagebox:frameos-cloud-objects`:

```sh
rclone copy storagebox:frameos-cloud-objects r2:frameos-cloud
```

Copying the whole backup back is safe and is usually the right move: the store
only ever grows, keys are content digests, and objects nothing references are
swept later (`scripts/object-store-sweep.sh`) rather than being a problem.

**Rehearsed 2026-08-17, passed.** The first copy shipped all 173 objects
(97 MB) in 19 s. Six objects sampled across `store/scene-versions`,
`store/scene-previews` and `frames/…/cache` were pulled back off the Storage
Box and hashed: every one matched the sha256 in its own key. That is the whole
verification — a content-addressed store cannot restore the wrong bytes without
the name disagreeing with them.

### Results so far

**2026-08-15 — both paths rehearsed for the first time, both passed.** Run
against real production backups on a throwaway Ubuntu 26.04 VM
(`raamike.orb.local`) with Postgres 18.4 and pgBackRest 2.58.0, matching
prod exactly. Everything below was measured, not estimated.

*Logical dump path* (`restore-drill.sh --sftp`): `db-20260815T104038Z.dump`,
117 MB, 195 TOC entries. Download + restore + verify took 12 s end to end.
Restored clean (`pg_restore` exit 0, zero errors): 3 accounts, 5 frames, 67
store scenes, 112 scene versions, 1299 audit events, 31 migrations, 3 MB of
scene images and 46 MB of frame asset files all readable.

*Whole-box path* (host tarball + pgBackRest, the procedure under "Whole box"
above): the tarball unpacked to 101 files with the env secrets and
letsencrypt state present as documented; `pgbackrest info` reached the repo
from a machine that had never written to it; the restore pulled 156.7 MB /
1481 files in 10 s, then replayed 42 WAL segments and reached
`archive recovery complete`. Final state was ~1 minute behind the moment the
drill started — the ≤5 min RPO claim holds.

Two things the drill found, both now fixed above and worth knowing before
you are doing this under pressure:

- **The data directory alone will not start.** Debian/Ubuntu keeps
  `postgresql.conf` in `/etc/postgresql/18/main`, not in the data directory,
  so a pgBackRest restore yields a cluster Postgres refuses to open
  (`could not access the server configuration file`). The config is in the
  host tarball — restore it too, which is why step 2 comes before step 3.
- **Do not pass `--type=none`.** It skips writing `recovery.signal` and
  `restore_command`, and Postgres then fails with `could not locate required
  checkpoint record`. The plain `restore` (or `--type=time` for PITR) shown
  above is correct.

Also measured: WAL replay from the Storage Box runs at roughly **1.8 s per
16 MB segment**, because every `archive-get` is its own SFTP round trip. A
recovery target far from a base backup is therefore minutes-to-hours of
replay proportional to segment count — budget for it, and prefer restoring
from the newest differential. Wait for `pg_is_in_recovery()` to return false
before believing any row counts; querying during replay returns a
consistent-but-stale database, which reads exactly like a partial restore.

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
