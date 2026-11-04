# CI costs: what still runs on Depot, and how it gets to zero

An audit of 2026-11-04. The monthly Depot invoice is ~$50 and the project's
cache store reads 250 GB; nothing else in CI costs money (the repository is
public, so GitHub-hosted runners and GHCR storage are free, and the
self-hosted pool on monster is paid for whatever it runs,
`tools/gha-runners/README.md`). This file says exactly which four steps
still touch Depot, how often, what the store holds, and what replaces each
one. When the last step is gone, delete this file's "Exit" section and keep
the map.

## Where every workflow runs (2026-11-04)

| workflow | runners | Depot? |
| --- | --- | --- |
| `pull-request-tests.yml` | epyc-4 / epyc-8 (fork PRs: ubuntu-latest), ubuntu-latest for the visual suites | no |
| `e2e-docker.yml` | ubuntu-latest | **yes**: the esp32-ci image, every run |
| `frameos-cross.yml`, `frameos-cross-toolchain.yml` | epyc-8 + ubuntu-24.04-arm; toolchain images via plain `docker buildx` to Docker Hub | no |
| `buildroot-base-image.yml`, `frameos-buildroot.yml` | epyc-32 with `/mnt/cache` (ccache + downloads) | no |
| `docker-publish-multi.yml` (release) | ubuntu-24.04, epyc-8, epyc-32, ubuntu-24.04-arm | **yes**: three esp32-ci builds + the multi-arch runtime image |
| `cloud-ci.yml`, `npm-publish.yml`, the rest | ubuntu-latest / ubuntu-24.04 | no |

Depot *runners* left in 2026-08 (PR #381: "$15 to $250+/month"); the
Buildroot ccache left Depot's store for `/mnt/cache` with it. What stayed,
deliberately, was `depot/build-push-action` for container image builds —
"the esp32-ci layer cache shared with e2e-docker, and push-multiarch's
remote amd64+arm64 builders". That is the whole bill today. There is no
Depot Cache (sccache/turbo), no Depot registry, no Depot GitHub Actions
cache, and no Depot label in `.github/actionlint.yaml`; `DEPOT_TOKEN` is
the only secret, project `rsbh2wrlkj` the only project.

## The four steps

All four are `depot/build-push-action@v1` on project `rsbh2wrlkj`.
Timings are from the runs of 2026-11-02/03 (`gh api .../jobs`).

1. **`e2e-docker.yml` → "Build and boot ESP32 firmware image"**, target
   `esp32-ci`, `load: true` (Depot builds remotely, then streams the image
   into the runner's Docker). Runs on **every pull-request push and every
   push to main**: 723 runs in the 30 days to 2026-11-04 (536 PR, 187 push;
   547 green, 82 red, 80 cancelled). The step takes 103–181 s per run. Its
   log shows what Depot does each time: the toolchain layers are cache
   hits, then — because `esp32-ci` copies `/app/frameos` out of
   `app-builder` — it rebuilds the per-commit tail of `app-builder` for
   every push: `nimble assets` (20 s), the wasm preview bundle (15 s), the
   frontend `pnpm run build` (22 s), `js_check` (2 s), none of which the
   firmware build uses, then ships the image to the runner (~45 s) after
   an 80 MB context upload. Forked PRs (no secret) already take the
   fallback: a plain `docker build --target esp32-ci`.
2. **Release → "Build ESP32 firmware (generic, all panels)"** on epyc-8:
   the same esp32-ci build, 253–269 s, then `docker run` on the slot.
3. **Release → "Build ESP32 firmware per flash layout"** (two jobs, S3 and
   C3) on ubuntu-24.04: the same build again, 244–249 s each on a warm day,
   564–724 s on 2026-11-02 when the cache was colder.
4. **Release → `push-multiarch`**: the runtime image for
   `linux/amd64,linux/arm64/v8`, built on two Depot machines and pushed to
   Docker Hub, 192–193 s. 85 of 135 steps are cache hits; the amd64
   `app-builder` is warm because step 1 just built it at the same commit,
   the arm64 one rebuilds its tail each release (`pnpm install` 104 s, the
   wasm bundle 22 s, the frontend 28 s, `nimble assets` 13 s).

Releases run about once a day (91 in the 90 days to 2026-11-04).

### What that is in Depot's two meters

Depot bills container **build minutes** (builder machine time; a
multi-platform build counts both machines) and **cache storage** (GB,
sampled hourly, averaged over the month). Our volume:

| source | per run | runs / month | builder-minutes / month |
| --- | --- | --- | --- |
| e2e esp32-ci (step 1) | ~2.4 min | ~630 completed | ~1,500 |
| release esp32-ci ×3 (steps 2–3) | ~12.5 min warm | ~30 | ~380 |
| release push-multiarch (step 4) | ~3.2 min × 2 machines | ~30 | ~190 |
| **total** | | | **~2,100** |

List prices on 2026-11-04 ([depot.dev/pricing](https://depot.dev/pricing),
[cache docs](https://depot.dev/docs/cache/overview)): the Developer plan is
$20/month with 500 container build minutes and 25 GB of storage included,
$0.04 per extra minute, $0.20 per extra GB-month, 14-day cache retention.
At those prices this volume would cost more than $50 — so the account is
on other terms (the invoice says which meter dominates; the arithmetic
here says the e2e job is ~70% of the minutes and nearly all of the bytes).

### The 250 GB

It is the project's BuildKit layer cache and nothing else. With a 14-day
retention and ~15 esp32-ci builds a day, ~300 builds are live at any time,
and every one of them wrote a fresh set of per-commit layers that no other
build can reuse: `COPY frontend`, `COPY frameos` (52 MB of source), the
`nimble assets` output (the 45 MB `repo_scenes.nim` among it), the wasm
bundle, `frontend/dist`, the `find … rm -rf` whiteout layer, `js_check`,
then `esp32-ci`'s own `COPY backend/app` / `embedded` / `repo` and its copy
of the whole `/app/frameos`. Call it 300–500 MB a build, stored
uncompressed as snapshots: 100–150 GB from the e2e job alone, plus the two
per-platform runtime-image caches and the per-release tails. The store is
not holding anything we want to keep: every byte in it is either a
toolchain layer that a registry cache reproduces from the Dockerfile, or
a per-commit layer that was only ever useful for one job. Deleting project
`rsbh2wrlkj` takes it to zero.

## Exit: the replacements, in the order to land them

The principle: toolchain layers live in a registry cache that is written
only from main and read everywhere; per-commit layers are built on the
runner that needs them and stored nowhere. GHCR (`ghcr.io/frameos/...`) is
the registry — free for a public repository, authenticated with the job's
`GITHUB_TOKEN` (`permissions: packages: write` on main pushes only), on
GitHub's own network for the hosted runners, and not Docker Hub, whose
anonymous pull limits are shared across every GitHub runner IP.

### 1. The esp32-ci image (steps 1–3; ~90% of the minutes, all of the bytes)

Replace the `depot/setup-action` + `depot/build-push-action` pair in all
three jobs with `docker/setup-buildx-action` + `docker/build-push-action`,
same `context` / `target` / `tags` / `load: true`, plus

```yaml
cache-from: type=registry,ref=ghcr.io/frameos/frameos-build-cache:esp32-ci
cache-to: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'type=registry,ref=ghcr.io/frameos/frameos-build-cache:esp32-ci,mode=max' || '' }}
```

and a `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN` (the release
jobs read the same cache; the PR job's secret-less fork fallback becomes
the normal path, since the cache is a public package). The
`DEPOT_AVAILABLE` branch, the comments about Depot's project and the
"byte-identical inputs" rule all go: the three builds share one cache tag
and stay identical by construction.

What to expect: the toolchain layers (ESP-IDF for two chips, QEMU, Nim,
the nimble packages, emsdk, the pnpm store — a few GB compressed) are
pulled from GHCR instead of streamed from Depot, and the per-commit tail
of `app-builder` runs on the runner's 4 vCPUs instead of Depot's 16: plan
on the e2e step going from ~2.5 min to ~4–5 min on ubuntu-latest. If that
matters, move the job to **epyc-8** (same `runs-on:` expression as the test
workflow: fork PRs stay on ubuntu-latest), where it is at least as fast as
today. `mode=max` on main pushes uploads each push's per-commit layers to
the cache tag too; the tag is overwritten each time, so bound GHCR with a
monthly `actions/delete-package-versions` of untagged versions rather than
by caring.

Land this first: it is exercised by every pull request, so the first PR
that carries it tests it, and the two release jobs are the same build.

**1b (optional, later): no image build at all on PRs.** The firmware
build needs only ESP-IDF + Nim + the nimble packages + the generated asset
modules (`src/assets/fonts.nim`, `tz_aliases.nim`: `utils/font.nim` and
`lib/tz.nim` import them, and the embedded runtime imports those). It
inherits node, emsdk and the frontend build only because
`tools/prepare_assets.py` makes the six asset modules and the on-frame web
UI (`assets/compiled/frame_web`) in one pass. Give it a modules-only mode
that skips `frame_web` (the embedded runtime never imports
`assets/frame_web.nim`), and the e2e job becomes `docker run -v
"$PWD:/app" ghcr.io/frameos/esp32-ci:<hash of Dockerfile + nimble.lock +
nim-prebuilt.sha256>` — a toolchain image published by a small workflow on
changes to those files, no build-push step anywhere, and the ~45 s image
load and the 80 MB context upload disappear with it.

### 2. The multi-arch runtime image (step 4)

Depot's one real advantage was a native arm64 builder. GitHub gives us one
for free: the cross legs already run on `ubuntu-24.04-arm` (Ampere; ~730 s
for a cross build there against ~810 s on epyc-8). So:

- Split `push-multiarch` into a `build-image` matrix of two native legs —
  `linux/amd64` on epyc-8 (or ubuntu-24.04), `linux/arm64` on
  `ubuntu-24.04-arm` — each `docker/build-push-action` with
  `outputs: type=image,name=frameos/frameos,push-by-digest=true,name-canonical=true,push=true`
  and its own GHCR cache tag (`runtime-amd64`, `runtime-arm64`,
  `mode=max`, written on every release since releases are main), exporting
  the digest as an artifact; then a `publish-image` job that logs in to
  Docker Hub and runs `docker buildx imagetools create -t frameos/frameos:<the four tags> frameos/frameos@sha256:<amd64> frameos/frameos@sha256:<arm64>`.
  This is Docker's documented multi-platform-by-digest recipe; no QEMU.
- Never emulate: the image compiles QuickJS, Nim programs, the wasm bundle
  and the frontend per platform. The 2026-08 measurement stands (an
  emulated 16-core build lost to four native cores); under QEMU on a
  hosted runner the arm64 leg would take an hour.
- Expect the arm64 leg at ~6–9 min warm (its ~3 min tail on Depot's 16
  vCPUs, on 4), the amd64 leg at ~4–6 min on epyc-8, and 15–25 min for
  either when the GHCR cache is cold. `push-multiarch` is the last job
  before "Create GitHub Release", so as written the release grows from ~22
  to ~26 min. To get that back, let the two build legs `need` only
  `update-versions` (the image does not consume the cross or Buildroot
  outputs — the Dockerfile copies no release asset; today's `needs` is
  publish ordering) and keep the ordering on `publish-image` alone: the
  legs then run beside the 14-minute cross matrix and the critical path is
  unchanged.
- The release workflow is `workflow_dispatch` on main and cannot be
  rehearsed; check the two legs once by hand before the first release
  (`docker buildx build --platform linux/arm64 --target runtime .` on an
  `ubuntu-24.04-arm` job in a scratch workflow, or on monster with the
  amd64 leg), then do the first release at a quiet hour.

### 3. Cleanup

Delete the `DEPOT_TOKEN` secret, the Depot project `rsbh2wrlkj` (the 250 GB
goes with it) and the subscription; drop `depot/setup-action` everywhere;
rewrite the "Runner sizing" header of `docker-publish-multi.yml` and the
"Deliberately NOT migrated" story it tells. The historical mentions in
`backend/app/utils/release_targets.py` (Graviton vs Ampere for armhf) and
`buildroot-base-image.yml` ("Depot's store went away") are measurements
and can stay.

### What this does not change

GitHub-hosted minutes stay free (public repository). GHCR stays free for
public packages; the only growth is the `mode=max` cache tags, bounded by
the retention job above. monster takes no new load unless step 1 moves
the e2e job onto epyc-8 (one more 8-core job per PR push, ~5 min; the pool
sizing rule in `tools/gha-runners/README.md` says epyc-8 ≥ 8 for the cross
legs plus Deploy E2E plus the ESP32 release job — a per-PR esp32 job on top
would want 10, which is the count today).
