# End-to-end tests

Four suites live here or are driven from here. Each has its own CI job; the
two snapshot suites are *rendered by CI* and their baselines are committed by
CI, which is the one rule that matters when you touch them (below).

| Suite | What it covers | CI job (`.github/workflows/`) | Baselines |
| --- | --- | --- | --- |
| Scene renderer snapshots (`./run`) | The Nim runtime rendering every fixture scene (`e2e/scenes`) with every built-in app, compared pixel-for-pixel | `pull-request-tests.yml` → "Visual Regression Tests (n/2)" | `e2e/snapshots/` |
| Frontend E2E + visual (`e2e/frontend-visual`) | Playwright against the real backend-served SPA — routing, drawers, settings, logs, terminal, auth, responsive layouts — plus the cloud `/frames` workspace served from `cloud-frontend/dist` (`visual-cloud-*.spec.ts`) | `pull-request-tests.yml` → "Frontend E2E + Visual Regression Tests (n/8)" | `e2e/frontend-visual/snapshots/` |
| Real SSH deploy (`e2e/deploy`) | A full backend deploy over real SSH/SCP to a disposable target (`/srv/frameos`, the systemd unit) | `pull-request-tests.yml` → "Deploy E2E SSH" | none (assertions only) |
| Docker + ESP32 images | The backend image boots and answers `/api/signup`; the ESP32 firmware builds on every flash layout, boots in QEMU, and the IDF-free modules pass their host tests | `e2e-docker.yml` → "Build Docker Image", "Build and boot ESP32 firmware image" | none |

## Scene renderer snapshots

```bash
cd e2e
./run              # render every scene and compare
./run dataGradient # only scenes whose name contains "dataGradient"
```

`./run` hands off to the `Makefile`: `makescenes.py` compiles the fixture
scenes in `scenes/` into `generated/`, a copy of `frameos/` is built with
them (`make build` in `tmp/frameos`), then `makesnapshots.py` runs that
binary once per scene and diffs the PNGs against `snapshots/`. Pixie renders
these in software from fonts in the repo, so the output is
platform-independent **as long as the app is deterministic**: fixtures
must pin `now`, seeds and any network input (the harness serves fixtures
from a local port, `E2E_FIXTURE_PORT`), or the snapshot will flap.

CI runs the same thing in two shards and — on pull requests from this
repository — commits any changed PNGs back to the PR branch as "FrameOS Bot"
("Commit Visual Regression Snapshots"). Pull `--rebase` before you push
again.

## Frontend E2E + visual

The Playwright suite. `e2e/frontend-visual/README.md` has the page/state
catalogue (`tests/visual-cases.ts`) and how to add one; the short version:

```bash
pnpm dev:redis                                  # once, in another shell
pnpm --dir frontend run build                   # the backend serves frontend/dist
pnpm --dir cloud-frontend run build             # only for the visual-cloud-* specs
pnpm exec playwright install chromium           # once
pnpm test:frontend-e2e                          # the @e2e interaction specs only
pnpm test:frontend-visual                       # everything, with pixel comparison
```

Playwright starts its own backend on `127.0.0.1:8989` with a disposable
SQLite database (`.tmp/frontend-visual.db`, seeded by
`scripts/seed_backend.py`) and Redis db 15. Gotchas that have cost real
time:

- **8989 is usually taken by your dev backend.** Override with
  `FRONTEND_VISUAL_PORT=8990 FRONTEND_VISUAL_BASE_URL=http://127.0.0.1:8990`
  instead of killing it.
- **Pixel comparisons always fail on macOS.** The committed snapshots are
  rendered on CI's Linux; local font rasterisation differs by a few
  percent. Run with `FRONTEND_VISUAL_MAX_DIFF=1` to skip the pixel diff and
  still exercise every interaction and the "no frontend errors" assertion.
  **Never run `--update-snapshots` locally** — it overwrites the CI-rendered
  baselines with macOS ones.
- **Do not keep one backend alive across runs** (`FRONTEND_VISUAL_REUSE_SERVER=1`):
  tests append frame logs and mutate settings, and fixture-dependent
  assertions (a logs view that expects a literal line count) drift. Let
  Playwright own the server, or delete `.tmp/frontend-visual.db` between
  runs. `FRONTEND_VISUAL_SKIP_WEBSERVER=1` points at a backend you run
  yourself.
- **The cloud specs need no backend** but do need `cloud-frontend/dist`;
  they share `tests/cloud-workspace-fixture.ts` (a fixed clock, route
  interception for the bundle). Register a spec's own `page.route` mocks
  after `serveCloudWorkspace` so they win, and answer `/api/fonts` with
  `{fonts: []}` on frame pages.
- **A frames-home test asserts zero `/frames/{id}/states` requests.**
  Anything rendered per frame on that page must not mount `controlLogic`
  or `scenesLogic` (they fetch states on mount); use a lightweight logic.

CI runs eight shards. Same-repo pull requests run with `--update-snapshots`
and "Commit Frontend Visual Snapshots" pushes changed PNGs to the PR branch
as "FrameOS Bot"; forked PRs and pushes to `main` only compare. So **a
visual job failing on CI is never a pixel diff**: read the log for the
frontend-error assertion (any console error, e.g. a 404'd resource) or the
`prepare` step that threw.

## Rules

- Do not run the Playwright suite during normal iteration; run it when the
  change is visual or the user asks. It takes minutes and owns a port.
- Never commit snapshot PNGs rendered locally, for either suite. CI is the
  source of truth; if a baseline needs to change, push the code and let the
  bot commit it.
- If a visual test you did not touch fails, check what else was running:
  a second backend on the port, or a reused server with drifted fixtures.

## Real SSH deploy

Opt-in, because it writes real system paths on its target. `e2e/deploy/README.md`
has the two ways to run it (the bundled Docker SSH target, or your own
throwaway host) and the flags it covers.
