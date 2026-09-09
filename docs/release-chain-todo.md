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

- `actions/checkout@v2` and `setup-python@v2` in seven places alongside v4/v6.
- `.github/actionlint.yaml` declares six dead `depot-*` labels, omits the
  live `epyc-*` ones, and nothing runs actionlint.
- An unpinned `emsdk` clone in an otherwise hash-pinned Dockerfile.
- The runtime image runs as root and ships a full build toolchain.
- `requirements.txt` has no `--hash` lines.
- `backend-docker.sh` truncates `.env.docker.local` with `>` and leaves it
  0644.
- `config.py` appends to `.env` with no leading newline.
- R2 write credentials are exposed to the shared-cache self-hosted runner
  pool.
- `turbo.json` uses `envMode: "loose"`.
