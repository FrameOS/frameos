# CI costs: what ran on Depot, and what replaced it

An audit of 2026-11-04, and the change that came out of it the same day.
The monthly Depot invoice was ~$50 and the project's cache store read
250 GB; nothing else in CI costs money (the repository is public, so
GitHub-hosted runners and GHCR storage are free, and the self-hosted pool
on monster is paid for whatever it runs, `tools/gha-runners/README.md`).
The first half of this file is the audit as it stood — which four steps
touched Depot, how often, what the store held — the second half what
replaced each one and what is left for the owner to do. Keep the map and
the rule ("What this does not change") when the owner tasks are done; the
rest is history.

## Where every workflow ran (2026-11-04, before the change)

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

## The four steps (as they were)

All four were `depot/build-push-action@v1` on project `rsbh2wrlkj`.
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

## What replaced it (shipped 2026-11-04)

The principle: toolchain layers live in a registry cache that is written
from main and read everywhere; per-commit layers are built on the runner
that needs them and stored nowhere. GHCR is the registry — free for a
public repository, authenticated with the job's `GITHUB_TOKEN`, on
GitHub's own network for the hosted runners, and not Docker Hub, whose
anonymous pull limits are shared across every GitHub runner IP. One
package, `ghcr.io/frameos/frameos-build-cache`, three tags:

| tag | written by | read by |
| --- | --- | --- |
| `esp32-ci` | `e2e-docker.yml` on every push to main (`mode=max`) | the same job on pull requests and forks; the release's three esp32-ci builds |
| `runtime-amd64` | the release's `build-runtime-image` amd64 leg (epyc-8) | itself, next release |
| `runtime-arm64` | the release's `build-runtime-image` arm64 leg (`ubuntu-24.04-arm`) | itself, next release |

### 1. The esp32-ci image (steps 1–3)

All three jobs now run `docker/setup-buildx-action` + a GHCR login +
`docker/build-push-action@v6` with the same `context` / `target` / `tags` /
`load: true` as before and `cache-from` the `esp32-ci` tag; only the e2e
job on a push to main adds `cache-to … mode=max` (the expression on the
step), and only that job holds `packages: write`. The `DEPOT_AVAILABLE`
branch and the fork fallback are gone: a fork takes the same path, reading
a public package with its read-only token. The "byte-identical inputs"
rule went with Depot — the three builds share one cache tag and stay
identical by construction.

What to expect: the toolchain layers (ESP-IDF for two chips, QEMU, Nim,
the nimble packages, emsdk, the pnpm store — a few GB compressed) are
pulled from GHCR instead of streamed from Depot, and the per-commit tail
of `app-builder` runs on the runner's 4 vCPUs instead of Depot's 16: the
e2e step should land at ~4–5 min instead of ~2.5. The job stays on
`ubuntu-latest` on purpose: an epyc-8 job per PR push, next to the test
workflow's one and a main push's six cross legs, would queue two
overlapping runs on the ten slots. Move it (the test workflow's
`runs-on:` expression keeps forks on GitHub) only if the minutes start to
matter. A missing or unreadable cache tag is a buildx warning and a cold
build (~15–20 min on a hosted runner), never a failure — that is how the
first push to main after this change seeds the tag.

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
changes to those files, no build-push step anywhere, and the image load
and the 80 MB context upload disappear with it.

### 2. The multi-arch runtime image (step 4)

Depot's one real advantage was a native arm64 builder. GitHub gives us one
for free: the cross legs already run on `ubuntu-24.04-arm` (Ampere; ~730 s
for a cross build there against ~810 s on epyc-8). So `push-multiarch` is
now two jobs:

- `build-runtime-image`, a matrix of two native legs — `linux/amd64` on
  epyc-8, `linux/arm64` on `ubuntu-24.04-arm` — each a
  `docker/build-push-action` with
  `outputs: type=image,name=frameos/frameos,push-by-digest=true,name-canonical=true,push=true`
  and its own GHCR cache tag (`mode=max`, written every release), handing
  its digest on as a one-day artifact. The legs `need` only
  `update-versions`: the Dockerfile copies no release asset, so they run
  beside the 14-minute cross matrix instead of after it.
- `push-multiarch` (the name the downstream `needs` know), after the cross
  and Buildroot jobs as before, runs `docker buildx imagetools create` with
  the four tags over the two digests — Docker's documented
  multi-platform-by-digest recipe — and inspects the result. Nothing is
  built there; the ordering that tags appear only once the binaries exist
  is this job's `needs`.
- Never emulate: the image compiles QuickJS, Nim programs, the wasm bundle
  and the frontend per platform. The 2026-08 measurement stands (an
  emulated 16-core build lost to four native cores); under QEMU on a
  hosted runner the arm64 leg would take an hour.
- Expect the arm64 leg at ~6–9 min warm (its ~3 min tail on Depot's 16
  vCPUs, on 4), the amd64 leg at ~4–6 min on epyc-8, and 15–25 min for
  either when its GHCR tag is cold — the first release after this change —
  and both still finish before the cross matrix does, so the release stays
  at ~22 min.

### 3. Hygiene

`ghcr-cache-retention.yml` deletes the package's untagged versions weekly
(every write re-points a tag and leaves the previous manifest behind;
public packages are free, so this is tidiness). Nothing reads a cache by
digest, only by tag, so no build in flight is cut off.

## Owner tasks (the parts no workflow can do)

1. **Watch the first push to main** after this change: the e2e job's
   "Build ESP32 CI Docker image" step must end with `exporting cache to
   registry` succeeding. If GHCR refuses the push (a 403 on
   `frameos-build-cache`), the org's package settings do not let a
   workflow create a package: create it once by hand or allow it, then
   re-run. A cold build on that first run is expected.
2. **Make the package public** (GitHub → the org's Packages →
   `frameos-build-cache` → Package settings → Change visibility), so fork
   pull requests read it without a token and nothing depends on the
   repository link.
3. **Watch the first release's** two `Build runtime image` legs and the
   `push-multiarch` inspect output (two platforms listed under
   `frameos/frameos:<version>`). The release workflow is
   `workflow_dispatch` on main and cannot be rehearsed; do that release at
   a quiet hour. If a leg fails, the previous release's tags are untouched
   (nothing is tagged until the merge step).
4. **Then delete** the `DEPOT_TOKEN` repository secret, Depot project
   `rsbh2wrlkj` (the 250 GB goes with it) and the subscription. The
   historical mentions in `backend/app/utils/release_targets.py` (Graviton
   vs Ampere for armhf) and `buildroot-base-image.yml` ("Depot's store went
   away") are measurements and stay.

### What this does not change

GitHub-hosted minutes stay free (public repository). GHCR stays free for
public packages; the only growth is the `mode=max` cache tags, bounded by
the retention job above. monster takes one more 8-core job per release
(the amd64 runtime leg, beside the six cross legs and the generic ESP32
job: eight of the ten epyc-8 slots, the sizing rule's minimum) and nothing
per pull request. The rule for a new image build in a workflow: it reads
one of these caches or adds a tag to the package — never a paid builder,
and never QEMU for the runtime image.
