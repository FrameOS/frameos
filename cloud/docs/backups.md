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
- **The object store has its own nightly copy**, to the same Storage Box
  and through the same crypt remote (`boxcrypt:objects`):
  `frameos-cloud-object-backup.timer` at 05:17 UTC, an hour after the database
  job so the object copy can only ever be newer than the rows referencing it.
  It **copies, never syncs** — a sync would mirror a deletion in R2 onto the
  backup, which is exactly the failure it exists for. Objects are immutable
  and named after the sha256 of their own content, so copy-only is also
  complete: the backup accumulates everything that ever existed, and rclone
  runs with `--immutable` so a key whose content ever changed fails the run
  instead of overwriting the good copy.
- **A bucket lock protects `store/`** (see below): 30-day retention, so a
  leaked R2 key can neither destroy the only copy nor empty the live prefix.
  `frames/` stays deletable on purpose — it is a cache whose job is to evict.
  Keep the keys to the two services that need them regardless: the lock buys
  30 days, not immunity.
- **No blob bytes remain in Postgres.** The `content` columns are empty
  everywhere; a database backup carries the rows, the keys and the recorded
  sizes, and none of the bytes.

**Nothing leaves the box in clear (since 2026-09-05).** Every off-site
artifact is encrypted on the host with a key Hetzner never sees: the
nightly dump, the host tarball and the object copy go through an rclone
`crypt` remote (`boxcrypt`, names and bytes encrypted; NaCl secretbox with
a scrypt-derived key), and the pgBackRest repository uses its own
client-side cipher (`repo1-cipher-type=aes-256-cbc`). Three passphrases,
all in the password manager under "FrameOS Cloud backup"; on the box in
`/root/.config/rclone/rclone.conf` (obscured — `rclone reveal` shows them)
and `/etc/pgbackrest/pgbackrest.conf`. Neither file is in any backup: a
backup must not carry the key that opens it. Losing the password manager
entry *and* the box loses every off-site copy; that is the trade, and it
is why the entry exists. `pg-backup.sh` and `object-store-backup.sh`
refuse a destination that is not a crypt remote.

Two independent layers ship to the Hetzner Storage Box
(`u651211.your-storagebox.de`, SFTP port 23, SSH-key auth):

1. **pgBackRest — continuous ("live") backups, point-in-time recovery.**
   Postgres archives every WAL segment to the Storage Box as it is produced
   (at most 5 minutes behind, per `archive_timeout`), on top of weekly full
   and daily differential base backups. Recovery point: minutes; recovery
   window: ~4 weeks (`repo1-retention-full=4`). Repo config:
   `/etc/pgbackrest/pgbackrest.conf`, stanza `frameos`, repo path
   `/home/pgbackrest-enc` on the box, encrypted with the repo cipher (the
   pre-encryption repo at `/home/pgbackrest` is frozen — nothing writes to
   it — and is deleted on 2026-10-03, once the encrypted repo has held a
   full four-week window of its own). Timers:
   `frameos-cloud-pgbackrest-full.timer` (Sun 02:47 UTC) and
   `frameos-cloud-pgbackrest-diff.timer` (Mon–Sat 02:47 UTC), both running
   as `postgres`.
2. **Nightly logical dump + host config** — `frameos-cloud-backup.timer`
   (04:17 UTC) runs `/usr/local/bin/frameos-cloud-backup` (source:
   `cloud/ops/backup/pg-backup.sh`): a `pg_dump` custom-format dump
   (verified with `pg_restore --list` before upload) plus a tarball of
   everything on the host that is in neither the repo nor the database
   (2026-08 audit): `/etc/frameos-cloud`, nginx, letsencrypt's renewal
   configs and ACME account (not `live/`, `archive/` or `keys/` — TLS
   private keys are reissued, not restored), postgres, pgbackrest and ufw
   config, the systemd units, all of `/usr/local/bin`, `/root` ops scripts
   and logs, the release stamps, and a generated rebuild manifest
   (installed packages, enabled units, tool versions). Deliberately NOT in
   it: `/root/.ssh`, `/root/.config/rclone` and `/var/lib/postgresql/.ssh`
   — the Storage Box key and the crypt passphrases, which the laptop and
   the password manager hold. Shipped with rclone to `boxcrypt:backups`
   (on the box: `frameos-cloud-encrypted/…`, ciphertext names) and pruned
   after 30 days. The logical
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
- Encryption passphrases (three): the rclone crypt `password` and
  `password2` for `boxcrypt`, and pgBackRest's `repo1-cipher-pass`. Source
  of truth is the password manager; the box holds working copies in
  `/root/.config/rclone/rclone.conf` (obscured) and
  `/etc/pgbackrest/pgbackrest.conf`. They are not in the host tarball. To
  rotate: a new crypt remote (new folder, new passphrases), let 30 days of
  nightly runs fill it, then delete the old folder; pgBackRest cannot
  re-key a repo, so a rotation there is a new `repo1-path` + `stanza-create`
  + a full backup, exactly how the move to encryption was done.
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
ssh <host> rclone lsl boxcrypt:backups                # readable names, via the crypt layer
ssh <host> rclone lsl storagebox:frameos-cloud-encrypted/backups   # what Hetzner sees
```

`pgbackrest info` is the health check that matters for the live layer: the
newest backup's WAL "max" keeps advancing as segments archive. The nightly
job runs that check for you (status `ok`, newest base backup under
`PGBACKREST_MAX_AGE_HOURS`, default 36 h, at least one archived WAL segment)
after shipping its own artifacts, and fails the run — so the same
healthchecks.io check pages — when the live layer is stuck. Each success ping
carries `pitr_latest=<type>@<age>h wal_max=<segment>` alongside the box
capacity.

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
rclone copy boxcrypt:backups/db-<stamp>.dump /root/restore/
pg_restore --clean --if-exists --no-owner \
  -d "$DATABASE_URL" /root/restore/db-<stamp>.dump
systemctl start "frameos-cloud-auth-web@$(cat /etc/frameos-cloud/active-port).service" frameos-cloud-frame-hub.service
```

For a single table, restore into a scratch database (see "Rehearsal") and
copy rows across with `psql` — a full `--clean` restore for one table
throws away everything newer in every other table.

### Whole box (host dead or unreachable)

1. Provision a fresh server ([deployment.md](deployment.md) — same OS,
   Node 22, Postgres, nginx). From the laptop / password manager, put on
   it: the Storage Box key (`/root/.ssh/hetzner-storage.key`, plus a
   postgres-owned copy, `known_hosts` via `ssh-keyscan -p 23`) and an
   `rclone.conf` built from `ops/backup/rclone.conf.example` with the
   `boxcrypt` passphrases. Nothing in the backups substitutes for this
   step — that is the point of them being encrypted.
2. Fetch the newest `host-<stamp>.tar.gz` from `boxcrypt:backups` and
   unpack at `/`: restores all env secrets, nginx/postgres/pgbackrest/ufw
   config, letsencrypt renewal state, the systemd units and the
   `/usr/local/bin` scripts. Then `certbot certonly` (or `certbot renew
   --force-renewal`) for the TLS keys, which the tarball no longer carries.
   Its `var/backups/frameos-cloud/manifest.txt` lists the packages and
   enabled units the old box had — the checklist for step 1.
3. Restore the database: install pgbackrest; `/etc/pgbackrest/pgbackrest.conf`
   comes out of the host tarball with the repo cipher passphrase in it (or
   rebuild it from this doc plus the password manager), then
   `pgbackrest --stanza=frameos restore` into an empty data directory (or
   use the newest nightly dump as above if you prefer logical).
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
# readable (and decryptable) from somewhere other than the host that wrote
# them, which is the case that matters when the host is the thing that died.
# rclone.conf: ops/backup/rclone.conf.example with the Storage Box key and
# the boxcrypt passphrases from the password manager filled in.
sudo -u postgres RCLONE_CONFIG=/path/to/rclone.conf ./restore-drill.sh

# On the prod box: root fetches through the crypt remote (the config lives
# under /root), postgres restores. /root is 0700, so stage the dump where
# postgres can read it.
d="$(mktemp -d /tmp/restore-drill.XXXXXX)"; chmod 755 "$d"
rclone copy "boxcrypt:backups/$(rclone lsf boxcrypt:backups --include 'db-*.dump' | sort | tail -1)" "$d"
chmod 644 "$d"/db-*.dump
sudo -u postgres /usr/local/bin/frameos-cloud-restore-drill --dump "$d"/db-*.dump
rm -rf "$d"
```

Row counts alone would pass on a dump whose `bytea` columns were truncated,
so the drill also sums `length(content)` over the blob tables — that forces
Postgres to read every byte back out of restored TOAST storage — and asserts
that an empty-but-valid restore fails rather than looking like a pass.

That sum is **zero** now — the blob bytes live in the object store, and the
drill's assertion is that every scene image row has either bytes or an
`object_key` (the first encrypted-backup drill on 2026-09-05 tripped the
older "bytes are zero" form, a false alarm from before the move). A green
drill says the rows and keys are back; whether the blobs behind the keys are
recoverable is the object store's question, rehearsed separately below.

### Bucket lock: `store-lock`, prefix `store/`, 30 days (enabled 2026-08-17)

R2 has **no object versioning**. Its equivalent is a *bucket lock*: prefix-
scoped retention rules that make R2 refuse to delete or overwrite a matching
object until the retention passes. Locks take precedence over lifecycle rules,
and a bucket cannot be emptied while any lock exists — which is exactly the
protection wanted against a leaked key.

**Lock `store/`, never `frames/`.** The two prefixes have opposite jobs.
`store/` holds published scenes, previews and gallery images: irreplaceable
user content, deleted only when an owner removes something. `frames/<id>/cache/`
is a per-frame LRU of device snapshots that is *supposed* to evict, and every
byte of it can be re-fetched from the device; locking it would pin the cache
forever and grow the bill for nothing.

**Retention is a trade-off, not a maximum.** Indefinite retention on `store/`
would mean a scene an owner deleted stays in the bucket forever, which
collides with the deletion rights in the data-subject runbook. A finite window
(30 days is a reasonable start) covers the gap between an object being written
and the nightly off-box copy picking it up, plus enough time to notice a wipe
and respond — while still letting a real deletion take effect eventually.

Changing it needs a token that can **edit R2 bucket configuration**; the app's
own credentials deliberately cannot (they answer 403 to bucket-config calls,
which is the correct blast radius for a key that sits in a web server). That
also means nothing in this repo can read the rule back — the dashboard is the
only source of truth for whether it is still on.

Dashboard: **R2 → `frameos-cloud` → Settings → Bucket lock rules**.

Or with Wrangler, authenticated as an account admin (`npx wrangler login`):

```sh
npx wrangler r2 bucket lock list frameos-cloud
npx wrangler r2 bucket lock add frameos-cloud store-lock store/ \
  --retention-days 30
```

`--retention-date YYYY-MM-DD` and `--retention-indefinite` are the other two
conditions; `wrangler r2 bucket lock remove frameos-cloud --name store-lock`
takes a rule off again.

The app is already prepared for a lock: `deleteBlobIfUnreferenced` logs a
refused delete (`object_store.delete_failed`) and carries on rather than
failing the request that removed the row, and the sweep reports refusals
instead of aborting. R2 answers **409 Conflict** for an object still under
retention — not 403, which is what a permission problem looks like, so the two
stay distinguishable in the logs. Both leave the object as garbage to collect after the
retention passes, so **expect refusals in the sweep's output** — that is the
lock working, not a fault.

**Verified 2026-08-17**, the day the rule went on: deleting an object under
`store/` answered 409 Conflict and the object stayed readable, while the same
call under `frames/` succeeded — so the rule is matching the intended prefix
and only that one. A sweep that reports no `object_store.delete_failed`
refusals at all is worth a second look: either there was genuinely nothing to
collect under `store/`, or the lock is no longer on.

## Restoring

What a full recovery needs today, in order: restore Postgres (either path
above), then restore the objects the rows point at — from R2 if it still has
them, otherwise from the encrypted copy (rclone decrypts on the way back):

```sh
rclone copy boxcrypt:objects r2:frameos-cloud
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
- Everything is chmod 600/700 on-box, transported over SSH, and — since
  2026-09-05 — encrypted before it leaves the box (see the top of this
  file): `boxcrypt` for the three rclone-shipped sets, the repo cipher for
  pgBackRest. Hetzner holds ciphertext with ciphertext names. The
  passphrases are the secret to keep OUTSIDE the backups; they are.
- What the encryption does not cover: the Postgres data directory and the
  env files on the box itself (that is the box's own disk, protected by
  its SSH access), and the R2 bucket (Cloudflare-side encryption at rest
  only; the objects are the store's published content plus per-account
  previews).
- Left over from before encryption, deliberately: the frozen plaintext
  pgBackRest repo at `/home/pgbackrest` on the Storage Box — delete it
  on **2026-10-03** (`rclone purge storagebox:pgbackrest`), by which time
  the encrypted repo has a four-week window of its own. The old plaintext
  nightly folders (`frameos-cloud-backups`, `frameos-cloud-objects`) were
  removed the day the encrypted copies were verified.
