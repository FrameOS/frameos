# CI, build and release chain — what is still open

The GitHub workflows, Dockerfiles, runner pool and repo hygiene. Reference
material: `docs/legacy-source-builds.md`, `cloud/docs/deployment.md`, the
comments in `.github/workflows/cloud-ci.yml` (nearly every line records the
incident that produced it). This file only carries the work. **When an item
ships, delete it.** Seeded from the 2026-09-09 full-repo review
(`docs/review-todo.md` §15), whose verdict on hygiene itself was clean: no
untracked clutter, no private keys or token literals in tracked files, no
`pull_request_target`, no `set -x`, no secret echoed to a log, lockfiles
current, every `pnpm-workspace.yaml` security-floor override resolving, fork
PRs kept off the self-hosted runner pool on all four jobs.

## Low / nits

- **The runtime image runs as root and ships a full build toolchain.** Both
  halves are held in place by the deprecated source-build path
  (`docs/legacy-source-builds.md`), so neither is a one-line `USER`:
  - The toolchain (Nim, `build-essential`, `docker-ce-cli`, `/root/.nimble`)
    IS the legacy build environment — the Modal executor runs this very
    image as its sandbox with `HOME=/root`
    (`backend/app/utils/modal_sandbox.py`), and `nim check` for Nim apps
    (`api/apps.py`) reads `/root/.nimble`. It leaves with item 1 of
    `docs/convergence-todo.md` ("Delete the compiler"), not before.
  - Dropping root is an entrypoint job (start as root, `chown` the data dir,
    `setpriv` down), not a Dockerfile `USER` — existing volumes hold a
    root-owned `frameos.db` and a 0600 `secret_key`, and the image
    auto-updates under people via Watchtower. What a first attempt has to
    get right, from the 2026-09-19 pass: stay root when
    `/var/run/docker.sock` is mounted (that variant is root on the host
    anyway) and under Home Assistant (`HASSIO_TOKEN`; the DB and key live in
    the Supervisor's `/data`); fall back to root with a warning when the
    `chown` fails (NFS / rootless Docker / userns-remap bind mounts) instead
    of boot-looping; give `redis-server` a writable `--dir` (it saves
    `dump.rdb` into `/app` today, and a failed bgsave makes Redis refuse
    writes — arq stops); a real `$HOME` for `~/.cache/frameos`; honour a
    `DATABASE_URL` outside `/app/db`. Needs a bench pass over an upgraded
    volume and an SD-image build before it ships.
