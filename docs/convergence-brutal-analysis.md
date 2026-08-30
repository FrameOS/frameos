# FrameOS — a deep, brutal analysis

*Written 2026-08-30, with PR #421 merged: compiled scenes are deprecated on
every surface, the converter is live, deploys install released binaries, and
nothing has been deleted yet. The question, as originally asked: "the goal
is to build a canvas onto which software can be loaded, which would run on
an ESP32 and a Pi, to show images on an e-ink display or HDMI/etc. Is this
the best way to do that?" Everything below is measured on this tree; the
work it implies lives in `docs/convergence-todo.md`.*

## What this project actually is (numbers)

Tracked source, excluding assets, `repo/` and the 35k-line vendored
Waveshare C:

| Plane | Size | Language |
|---|---|---|
| `frameos/src/frameos` runtime | 59k | Nim |
| `frameos/src/apps` built-in catalog | 11k | Nim (40 apps) |
| `frameos/src/drivers` | 15k | Nim (+35k vendored C) |
| `embedded/esp32` | 30k | C (ESP-IDF) |
| `embedded/pico` | 2k | C |
| `backend/` control plane | 85k | Python/FastAPI |
| `frontend/` | 96k | TS/React/kea |
| `cloud/apps/auth-web` | 104k | TS/Next.js |
| `cloud/` hub + packages + wrapper | 20k | TS |
| `e2e/` | 12k | Nim + TS |

Roughly half a million lines, five languages. 1,536 commits, **341 of them
in August 2026**; the only human committer since June is Marius (338), the
rest are snapshot bots. Bus factor is exactly 1, and the August rate says
most of the writing is agent-assisted — which makes the *reading* burden,
not the writing, the binding constraint. Two parallel schema histories: 74
Alembic migrations (backend) and 42 Drizzle migrations (cloud), for two
databases that both describe frames and scenes.

The stated goal still fits in one sentence. Half a million lines is not a
sentence.

## The honest verdict

Still no — this is not the best way to reach that goal; it is the
accumulated way. The last two days fenced off the oldest layer instead of
maintaining it as a peer, which is real progress. But fencing is not
deletion, and the count of parallel systems has not gone down anywhere.
By subsystem:

### 1. Four ways to execute one scene, still

- Python→Nim codegen: 4,367 lines (`backend/app/codegen/`, +725 of tests)
  — deprecated, warned about, off by default, **fully present**.
- The node-graph interpreter: 1,800 lines (`interpreter.nim`) — the default.
- The JS runtime: **8,802 lines of Nim that implement a TypeScript
  compiler** (`transpiler.nim` 2,219, `burrito.nim` 1,699, `app_runtime.nim`
  1,674, `runtime.nim` 1,088, `tokens.nim` 1,056, parser + source maps),
  over a QuickJS fetched as a tarball from bellard.org at build time.
- The wasm build of all that for the browser — which is **not in the
  repo**: `scene-render.ts` expects `public/frameos-wasm/frameos.wasm` to
  have been installed on the server and errors otherwise. The renderer
  every thin client and every browser preview depends on is a deploy-time
  side-load with no version stamp in the tree.

And the "loadable software" story the canvas exists for: **40 apps exist
only as Nim** (compiled into the firmware, a release to change one) and
**7 exist as JS** (actually loadable). A cloud push refuses any scene
carrying Nim an interpreter can't run — so the loadable catalog is seven
apps deep, and every scene beyond that leans on built-ins dispatched by
keyword into the binary. The deprecation removed the fourth way of
*writing* scenes; it added a 3.5k-line converter; it deleted nothing.

### 2. Four control planes, and each device answers N/A to half of it

Measured this week:

| Surface | Endpoints |
|---|---|
| Backend FastAPI (28 files) | 155 routes |
| Pi on-device server (7 route files, 2.4k lines) | 74 paths |
| ESP32 `fos_http.c` (2.9k lines) | 27 paths |
| Cloud auth-web | 120 `route.ts` files |

`docs/api-triality.md` says it plainly — "the long-term contract is not
three independent APIs" — and then its own 61-row capability table shows
27 N/A cells in the Pi column and ~24 in the ESP32 column. The cloud link
is better contained than it was: 20 verbs, all dispatched on both device
planes, with per-key version gating from one generated contract
(`docs/cloud-frames-contract.json`). But the contract's fine print records
the real state: of 23 settings keys, **8 work on both planes, 8 are
Linux-only, 7 are ESP32-only** — a 65% divergence in what "configure a
frame" even means. And the second FrameOS is alive and growing:
`fos_cloud.c` is 3,259 lines of C beside `hub_client.nim`'s 2,049 lines of
Nim, doing the same job twice, with three hand-maintained validators
(242 Nim + 259 C + 255 TS) kept honest only by generated tables and shared
fixtures. That layer was the *settled* answer (a Nim port was measured and
rejected at +57 KB flash) — settled is not the same as cheap.

### 3. Two rendering architectures on one microcontroller family

`localRenderSupported` in `embedded_firmware.py` is the fork: **esp32-s3
renders locally** (17.5k lines of `fos_*.c` plus 2.6k of Nim glue, RGB565
canvases, dither, strip fills, streaming socket decode — heroic,
genuinely impressive memory engineering), **esp32-c3 and both Picos are
thin clients** (539 lines of `embedded_device.py` serving FOSB bitmaps
plus 2k of Pico C). The Pi is a third architecture. The thin path is a
fraction of the code, produces pixel-identical output at full quality, and
is blocked from the cloud by an unanswered pricing question ("free cloud
rendering forever" — `docs/todo.md`), while every 8 MB board keeps
re-fighting the fat path board by board. Nobody has ruled whether
hub-rendering a *scene* violates the "no image proxies, ever" principle
(it doesn't — that principle is about external images — but the ruling has
never been written down). This is the largest undecided question in the
repo, and it is a decision, not a project.

### 4. Nim is the moat and the cage — unchanged

One dependency is a fork: **pixie, the render core**, patched for EXIF
endianness, gradient strip fills, and an ORC cycle that segfaulted every
HDMI frame from inside a driver `.so`. The rest of the lock file is two
maintainers' ecosystems (treeform, guzba) plus a framebuffer binding with
one contributor. The 8.8k-line homegrown TS compiler exists *because* the
runtime is Nim and must embed its own JS. None of this got worse this
week, and none of it got better: the converter reduces the Nim users
write to zero and the Nim we maintain by zero. The escape hatch (JS apps)
is real but seven apps wide.

### 5. The cloud is a second company

104k lines of Next.js, 120 API routes, 42 migrations, WebAuthn + 2FA +
sudo re-auth, a 72-tool MCP host, a scene store with immutable versions, a
streaming AI loop, R2 + PITR backups — and, since this week, a **public,
unauthenticated endpoint that spends the platform's OpenAI key**
(`/api/scenes/convert`, rate-limited per address, budgeted per day). Every
piece is individually defensible; the sum is a SaaS run by one person as a
side effect of a picture frame. The question the first version of this
analysis asked is still open: is the goal the canvas or the company? The
converter endpoint sharpens it — it should not stay public past the
deprecation window.

### 6. Verification is pointed at the wrong end

420 test files where the risk is lowest: 109 backend Python, 146 cloud TS,
159 Nim. Where the risk is highest: **six** ESP32 C unit tests, **zero**
frontend tests of any kind, ten Playwright specs, firmware exercised only
under QEMU, the Pico compiled but never booted by CI, and **no
hardware-in-the-loop anything** — the self-hosted runners are EPYC build
boxes, not benches. `docs/manual-testing-todo.md` currently holds 14 open
hardware checkboxes across the Pi and ESP32 benches. At 341 commits a
month, the gap between "merged" and "works on a panel" is the project's
largest accumulating liability — bigger than any line count above.

### 7. The deprecation is now a debt with a date

Stages 1–4 are done: no new Nim from the editor, warnings on every
surface, a working converter, binaries by default, `build_kind` recording
which frames still build from source. What remains is the only part with
payoff: **deleting ~9k lines** of codegen, cross-compile, build-host and
Modal machinery, plus their frontend and CI. The gate is honest (one
release plus a clean `build_kind` cycle) and **blind** — `build_kind`
lives in each self-hoster's own database, so the calendar, the cloud's
converter telemetry, and GitHub issues are the only observable signals.
If the date slips, the project keeps the worst of both: the maintenance
of the old path and the complexity of the fence around it.

## What is genuinely right (do not throw it out)

- The scene graph as portable data, one interpreter semantics from browser
  wasm to a Pi to an ESP32. Rare and valuable.
- Interpreted-by-default, release binaries, deploys that never compile.
- The contract discipline where it exists: one generated
  `cloud-frames-contract` consumed by Nim, C and TS, with shared fixtures.
  It is the pattern everything in §2 should converge on.
- The principles: outbound-only devices, scoped tokens, no shell verbs in
  the cloud, no image proxies on frames, paid = explicit.
- Deprecation done as warnings + converter + date, with the legacy path
  left *working* until deleted — not disabled-but-present.
- Vendor-C-only panel drivers; one timeout-wrapped process spawner; signed
  OTA on both halves.

## What "best" would look like from here

In order, and mostly by deleting or deciding rather than building —
the concrete items are `docs/convergence-todo.md`:

1. **Keep the deletion date.** Stage 5 is where the last two days' work
   pays off; everything else waits behind it.
2. **Build the bench before the next feature.** One Pi, one E1004, one
   colour Waveshare, flashed on every release tag. It converts §6 from a
   liability into a habit, and it is gated on nothing.
3. **Decide thin-vs-fat once**, as policy: capability flag picks the
   renderer, hub renders for boards below the line, and the pricing
   question gets an answer instead of blocking the architecture.
4. **Treat the wasm renderer as a release artifact** with a version stamp,
   and publish the browser-vs-firmware skew table. Preview lying about
   what a frame will draw is a quiet trust leak.
5. **Grow the JS catalog toward the Nim one**, converter-telemetry first:
   every "no JS equivalent" hit names the next bridge primitive or port.
6. **Stop growing the cloud's surface** until there is a second person or
   a stated business goal. Close the public converter endpoint when the
   deprecation window closes.

## Bottom line

The repo now contains its best design *and* a fence around its oldest one,
with a dated demolition permit. Nothing has been deleted, no architecture
count has gone down, and the biggest risks are unchanged: one person, no
bench, and a rendering decision nobody has made. The next unit of progress
is not a feature. It is a deletion, a decision, and a test rig — in that
order.
